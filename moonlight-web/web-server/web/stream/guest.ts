import { Api } from "../api.js"
import { PlayerSlot, RoomInfo, StreamCapabilities, StreamClientMessage, StreamServerMessage, TransportChannelId } from "../api_bindings.js"
import { showErrorPopup } from "../component/error.js"
import { Component } from "../component/index.js"
import { Settings } from "../component/settings_menu.js"
import { AudioPlayer } from "./audio/index.js"
import { buildAudioPipeline } from "./audio/pipeline.js"
import { BIG_BUFFER } from "./buffer.js"
import { defaultStreamInputConfig, StreamInput } from "./input.js"
import { Logger, LogMessageInfo } from "./log.js"
import { StreamStats } from "./stats.js"
import { WebSocketTransport } from "./transport/web_socket.js"
import { allVideoCodecs, getSelectedVideoCodec, VideoCodecSupport } from "./video.js"
import { VideoRenderer } from "./video/index.js"
import { buildVideoPipeline, VideoPipelineOptions } from "./video/pipeline.js"
import { getStreamerSize, InfoEvent, InfoEventListener } from "./index.js"

function getVideoCodecHint(settings: Settings): VideoCodecSupport {
    let videoCodecHint = allVideoCodecs()
    if (settings.videoCodec == "h264") {
        videoCodecHint = { H264: true, H264_HIGH8_444: true } as any
    } else if (settings.videoCodec == "h265") {
        videoCodecHint = { H265: true, H265_MAIN10: true, H265_REXT8_444: true, H265_REXT10_444: true } as any
    } else if (settings.videoCodec == "av1") {
        videoCodecHint = { AV1: true, AV1_MAIN8: true, AV1_MAIN10: true, AV1_REXT8_444: true, AV1_REXT10_444: true } as any
    }
    return videoCodecHint
}

/**
 * GuestStream - connects to a room as a guest (no authentication required)
 * This is a simplified stream that uses WebSocket transport only.
 */
export class GuestStream implements Component {
    private logger: Logger = new Logger()

    private api: Api

    private roomId: string
    private playerName: string | null

    private settings: Settings

    private divElement = document.createElement("div")
    private eventTarget = new EventTarget()

    private ws: WebSocket
    private iceServers: Array<RTCIceServer> | null = null

    private videoRenderer: VideoRenderer | null = null
    private audioPlayer: AudioPlayer | null = null

    private input: StreamInput
    private stats: StreamStats

    private streamerSize: [number, number]
    private transport: WebSocketTransport | null = null

    // Room state
    private roomInfo: RoomInfo | null = null
    private playerSlot: PlayerSlot | null = null
    private guestsKeyboardMouseEnabled: boolean = false

    constructor(api: Api, roomId: string, playerName: string | null, settings: Settings, viewerScreenSize: [number, number]) {
        this.logger.addInfoListener((info, type) => {
            this.debugLog(info, { type: type ?? undefined })
        })

        this.api = api
        this.roomId = roomId
        this.playerName = playerName
        this.settings = settings
        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Configure web socket - connect to guest endpoint
        const wsApiHost = api.host_url.replace(/^http(s)?:/, "ws$1:")
        const nameParam = playerName ? `&player_name=${encodeURIComponent(playerName)}` : ""
        this.ws = new WebSocket(`${wsApiHost}/guest/stream?room_id=${encodeURIComponent(roomId)}${nameParam}`)
        this.ws.addEventListener("error", this.onError.bind(this))
        this.ws.addEventListener("open", this.onWsOpen.bind(this))
        this.ws.addEventListener("close", this.onWsClose.bind(this))
        this.ws.addEventListener("message", this.onRawWsMessage.bind(this))

        // Stream Input
        const streamInputConfig = defaultStreamInputConfig()
        Object.assign(streamInputConfig, {
            mouseScrollMode: this.settings.mouseScrollMode,
            controllerConfig: this.settings.controllerConfig
        })
        this.input = new StreamInput(streamInputConfig)

        // Stream Stats
        this.stats = new StreamStats()
    }

    private debugLog(message: string, additional?: LogMessageInfo) {
        for (const line of message.split("\n")) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "addDebugLine", line, additional }
            })
            this.eventTarget.dispatchEvent(event)
        }
    }

    private async onMessage(message: StreamServerMessage) {
        if (typeof message === "object" && "DebugLog" in message) {
            this.debugLog(message.DebugLog.message, { type: message.DebugLog.ty ?? undefined })
        } else if (typeof message === "object" && "UpdateApp" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "app", app: message.UpdateApp.app }
            })
            this.eventTarget.dispatchEvent(event)
        } else if (typeof message === "object" && "ConnectionComplete" in message) {
            const capabilities = message.ConnectionComplete.capabilities
            const formatRaw = message.ConnectionComplete.format
            const width = message.ConnectionComplete.width
            const height = message.ConnectionComplete.height
            const fps = message.ConnectionComplete.fps

            const audioSampleRate = message.ConnectionComplete.audio_sample_rate
            const audioChannelCount = message.ConnectionComplete.audio_channel_count
            const audioStreams = message.ConnectionComplete.audio_streams
            const audioCoupledStreams = message.ConnectionComplete.audio_coupled_streams
            const audioSamplesPerFrame = message.ConnectionComplete.audio_samples_per_frame
            const audioMapping = message.ConnectionComplete.audio_mapping

            const format = getSelectedVideoCodec(formatRaw)
            if (format == null) {
                this.debugLog(`Video Format ${formatRaw} was not found!`, { type: "fatal" })
                return
            }

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionComplete", capabilities }
            })
            this.eventTarget.dispatchEvent(event)

            this.input.onStreamStart(capabilities, [width, height])
            this.stats.setVideoInfo(format ?? "Unknown", width, height, fps)

            await Promise.all([
                this.videoRenderer?.setup({
                    codec: format,
                    fps,
                    width,
                    height,
                }),
                this.audioPlayer?.setup({
                    sampleRate: audioSampleRate,
                    channels: audioChannelCount,
                    streams: audioStreams,
                    coupledStreams: audioCoupledStreams,
                    samplesPerFrame: audioSamplesPerFrame,
                    mapping: audioMapping,
                })
            ])
        } else if (typeof message === "object" && "ConnectionTerminated" in message) {
            this.debugLog(`ConnectionTerminated with code ${message.ConnectionTerminated.error_code}`, { type: "fatalDescription" })
        } else if (typeof message === "object" && "Setup" in message) {
            this.iceServers = message.Setup.ice_servers
            this.debugLog(`Received ICE servers, starting connection`)
            await this.startConnection()
        } else if (typeof message === "object" && "RoomJoined" in message) {
            this.roomInfo = message.RoomJoined.room
            this.playerSlot = message.RoomJoined.player_slot
            this.debugLog(`Joined room: ${this.roomInfo.room_id} - You are Player ${this.playerSlot + 1}`)
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomJoined", room: this.roomInfo, playerSlot: this.playerSlot }
            })
            this.eventTarget.dispatchEvent(event)
        } else if (typeof message === "object" && "RoomUpdated" in message) {
            this.roomInfo = message.RoomUpdated.room
            this.debugLog(`Room updated: ${this.roomInfo.players.length} players connected`)
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomUpdated", room: this.roomInfo }
            })
            this.eventTarget.dispatchEvent(event)
        } else if (typeof message === "object" && "RoomJoinFailed" in message) {
            this.debugLog(`Failed to join room: ${message.RoomJoinFailed.reason}`, { type: "fatal" })
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomJoinFailed", reason: message.RoomJoinFailed.reason }
            })
            this.eventTarget.dispatchEvent(event)
        } else if (typeof message === "object" && "PlayerLeft" in message) {
            this.debugLog(`Player ${message.PlayerLeft.slot + 1} left the room`)
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "playerLeft", slot: message.PlayerLeft.slot }
            })
            this.eventTarget.dispatchEvent(event)
        } else if (message === "RoomClosed") {
            this.debugLog(`Room closed by host`, { type: "fatal" })
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomClosed" }
            })
            this.eventTarget.dispatchEvent(event)
        } else if (typeof message === "object" && "GuestsKeyboardMouseEnabled" in message) {
            this.guestsKeyboardMouseEnabled = message.GuestsKeyboardMouseEnabled.enabled
            this.debugLog(`Guests keyboard/mouse ${this.guestsKeyboardMouseEnabled ? "enabled" : "disabled"}`)
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "guestsKeyboardMouseEnabled", enabled: this.guestsKeyboardMouseEnabled }
            })
            this.eventTarget.dispatchEvent(event)
        }
    }

    private async startConnection() {
        this.debugLog("Using WebSocket transport for guest connection")

        this.sendWsMessage({ SetTransport: "WebSocket" })

        const transport = new WebSocketTransport(this.ws, BIG_BUFFER, this.logger)
        this.transport = transport

        this.input.setTransport(transport)
        this.stats.setTransport(transport)

        // Setup video pipeline for data transport
        const videoCodecHint = getVideoCodecHint(this.settings)
        const videoSettings: VideoPipelineOptions = {
            supportedVideoCodecs: videoCodecHint,
            canvasRenderer: this.settings.canvasRenderer,
            forceVideoElementRenderer: this.settings.forceVideoElementRenderer
        }

        const { videoRenderer, supportedCodecs, error: videoError } = await buildVideoPipeline("data", videoSettings, this.logger)
        if (videoError || !videoRenderer) {
            this.debugLog("Failed to create video pipeline!", { type: "fatal" })
            return
        }

        videoRenderer.mount(this.divElement)
        this.videoRenderer = videoRenderer

        // Setup audio pipeline
        const { audioPlayer, error: audioError } = await buildAudioPipeline("data", this.settings, this.logger)
        if (!audioError && audioPlayer) {
            audioPlayer.mount(this.divElement)
            this.audioPlayer = audioPlayer
        } else {
            showErrorPopup("Failed to create audio player")
        }

        // Setup transport channels for video/audio
        await transport.setupHostVideo({ type: ["data"] })
        await transport.setupHostAudio({ type: ["data"] })

        const videoChannel = transport.getChannel(TransportChannelId.HOST_VIDEO)
        if (videoChannel.type == "data") {
            videoChannel.addReceiveListener((data) => {
                if (this.videoRenderer && 'submitPacket' in this.videoRenderer) {
                    (this.videoRenderer as any).submitPacket(data)
                }
            })
        }

        const audioChannel = transport.getChannel(TransportChannelId.HOST_AUDIO)
        if (audioChannel.type == "data" && this.audioPlayer) {
            audioChannel.addReceiveListener((data) => {
                if (this.audioPlayer && 'decodeAndPlay' in this.audioPlayer) {
                    (this.audioPlayer as any).decodeAndPlay({
                        durationMicroseconds: 0,
                        timestampMicroseconds: 0,
                        data
                    })
                }
            })
        }

        // Guests don't send StartStream - they join an existing stream
        // The server will send ConnectionComplete when ready
        this.debugLog("Transport ready, waiting for ConnectionComplete from server")
    }

    private onWsOpen() {
        this.debugLog("WebSocket connected to guest endpoint")
    }

    private onWsClose(event: CloseEvent) {
        this.debugLog(`WebSocket closed: ${event.code} ${event.reason}`)
    }

    private onRawWsMessage(event: MessageEvent) {
        // Binary messages are handled directly by the WebSocketTransport's channels
        // We only need to handle JSON messages here
        if (typeof event.data !== "string") {
            return
        }

        let message: StreamServerMessage
        try {
            message = JSON.parse(event.data)
        } catch (e) {
            this.debugLog(`Failed to parse message: ${e}`)
            return
        }

        this.onMessage(message)
    }

    private onError(event: Event) {
        this.debugLog(`WebSocket error: ${event}`)
    }

    private sendWsMessage(message: StreamClientMessage) {
        if (this.ws.readyState == WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message))
        }
    }

    // Public API
    getInput(): StreamInput {
        return this.input
    }

    getStats(): StreamStats {
        return this.stats
    }

    getVideoRenderer(): VideoRenderer | null {
        return this.videoRenderer
    }

    getRoomInfo(): RoomInfo | null {
        return this.roomInfo
    }

    getPlayerSlot(): PlayerSlot | null {
        return this.playerSlot
    }

    isHost(): boolean {
        return this.playerSlot === 0
    }

    addInfoListener(listener: InfoEventListener) {
        this.eventTarget.addEventListener("stream-info", listener as EventListener)
    }

    setGuestsKeyboardMouseEnabled(enabled: boolean) {
        this.sendWsMessage({
            SetGuestsKeyboardMouseEnabled: { enabled }
        })
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }

    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }
}
