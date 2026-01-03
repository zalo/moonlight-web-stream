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
import { Transport, TransportShutdown } from "./transport/index.js"
import { WebSocketTransport } from "./transport/web_socket.js"
import { WebRTCTransport } from "./transport/webrtc.js"
import { allVideoCodecs, andVideoCodecs, createSupportedVideoFormatsBits, emptyVideoCodecs, getSelectedVideoCodec, hasAnyCodec, VideoCodecSupport } from "./video.js"
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
    private transport: Transport | null = null

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
        } else if (typeof message === "object" && "WebRtc" in message) {
            // Handle WebRTC signaling messages
            const webrtcMessage = message.WebRtc
            if (this.transport instanceof WebRTCTransport) {
                this.transport.onReceiveMessage(webrtcMessage)
            } else {
                this.debugLog(`Received WebRTC message but transport is currently ${this.transport?.implementationName}`)
            }
        }
    }

    private async startConnection() {
        this.debugLog(`Using transport: ${this.settings.dataTransport}`)

        if (this.settings.dataTransport == "auto") {
            let shutdownReason = await this.tryWebRTCTransport()

            if (shutdownReason == "failednoconnect") {
                this.debugLog("Failed to establish WebRTC connection. Falling back to Web Socket transport.")
                await this.tryWebSocketTransport()
            }
        } else if (this.settings.dataTransport == "webrtc") {
            await this.tryWebRTCTransport()
        } else if (this.settings.dataTransport == "websocket") {
            await this.tryWebSocketTransport()
        }

        this.debugLog("Tried all configured transport options but no connection was possible", { type: "fatal" })
    }

    private setTransport(transport: Transport) {
        if (this.transport) {
            this.transport.close()
        }

        this.transport = transport

        this.input.setTransport(this.transport)
        this.stats.setTransport(this.transport)
    }

    private async tryWebRTCTransport(): Promise<TransportShutdown> {
        this.debugLog("Trying WebRTC transport")

        this.sendWsMessage({
            SetTransport: "WebRTC"
        })

        if (!this.iceServers) {
            this.debugLog(`Failed to try WebRTC Transport: no ice servers available`)
            return "failednoconnect"
        }

        const transport = new WebRTCTransport(this.logger)
        transport.onsendmessage = (message) => this.sendWsMessage({ WebRtc: message })

        transport.initPeer({
            iceServers: this.iceServers
        })
        this.setTransport(transport)

        // Wait for negotiation
        const result = await (new Promise((resolve, _reject) => {
            transport.onconnect = () => resolve(true)
            transport.onclose = () => resolve(false)
        }))
        this.debugLog(`WebRTC negotiation success: ${result}`)

        if (!result) {
            return "failednoconnect"
        }

        const videoCodecSupport = await this.createPipelines()
        if (!videoCodecSupport) {
            this.debugLog("No video pipeline was found for the codec that was specified.", { type: "fatalDescription" })

            await transport.close()
            return "failednoconnect"
        }

        // Guests don't send StartStream - they join an existing stream
        // The server will send ConnectionComplete when ready
        this.debugLog("WebRTC transport ready, waiting for ConnectionComplete from server")

        return new Promise((resolve, _reject) => {
            transport.onclose = (shutdown) => {
                resolve(shutdown)
            }
        })
    }

    private async tryWebSocketTransport(): Promise<TransportShutdown | undefined> {
        this.debugLog("Trying Web Socket transport")

        this.sendWsMessage({
            SetTransport: "WebSocket"
        })

        const transport = new WebSocketTransport(this.ws, BIG_BUFFER, this.logger)

        this.setTransport(transport)

        const videoCodecSupport = await this.createPipelines()
        if (!videoCodecSupport) {
            this.debugLog("Failed to start stream because no video pipeline with support for the specified codec was found!", { type: "fatal" })
            return
        }

        // Guests don't send StartStream - they join an existing stream
        // The server will send ConnectionComplete when ready
        this.debugLog("WebSocket transport ready, waiting for ConnectionComplete from server")

        return new Promise((resolve, _reject) => {
            transport.onclose = (shutdown) => {
                resolve(shutdown)
            }
        })
    }

    private async createPipelines(): Promise<VideoCodecSupport | null> {
        if (!this.transport) {
            this.debugLog("Failed to create pipelines without transport")
            return null
        }

        // Create video pipeline
        const codecHint = getVideoCodecHint(this.settings)
        this.debugLog(`Codec Hint by the user: ${JSON.stringify(codecHint)}`)

        if (!hasAnyCodec(codecHint)) {
            this.debugLog("Couldn't find any supported video format.", { type: "fatalDescription" })
            return null
        }

        const transportCodecSupport = await this.transport.setupHostVideo({
            type: ["videotrack", "data"]
        })
        this.debugLog(`Transport supports these video codecs: ${JSON.stringify(transportCodecSupport)}`)

        const videoSettings: VideoPipelineOptions = {
            supportedVideoCodecs: andVideoCodecs(codecHint, transportCodecSupport),
            canvasRenderer: this.settings.canvasRenderer,
            forceVideoElementRenderer: this.settings.forceVideoElementRenderer
        }

        const video = this.transport.getChannel(TransportChannelId.HOST_VIDEO)
        if (video.type == "videotrack") {
            const { videoRenderer, supportedCodecs, error } = await buildVideoPipeline("videotrack", videoSettings, this.logger)

            if (error || !videoRenderer) {
                this.debugLog("Failed to create video pipeline!", { type: "fatal" })
                return null
            }

            videoRenderer.mount(this.divElement)

            video.addTrackListener((track) => {
                videoRenderer.setTrack(track)
            })

            this.videoRenderer = videoRenderer
        } else if (video.type == "data") {
            const { videoRenderer, supportedCodecs, error } = await buildVideoPipeline("data", videoSettings, this.logger)

            if (error || !videoRenderer) {
                this.debugLog("Failed to create video pipeline!", { type: "fatal" })
                return null
            }

            videoRenderer.mount(this.divElement)

            video.addReceiveListener((data) => {
                videoRenderer.submitPacket(data)
            })

            this.videoRenderer = videoRenderer
        } else {
            this.debugLog(`Failed to create video pipeline with transport channel of type ${video.type}`)
            return null
        }

        // Create audio pipeline
        await this.transport.setupHostAudio({
            type: ["audiotrack", "data"]
        })

        const audio = this.transport.getChannel(TransportChannelId.HOST_AUDIO)
        if (audio.type == "audiotrack") {
            const { audioPlayer, error } = await buildAudioPipeline("audiotrack", this.settings, this.logger)

            if (error || !audioPlayer) {
                showErrorPopup("Failed to create audio player")
            } else {
                audioPlayer.mount(this.divElement)
                audio.addTrackListener((track) => audioPlayer.setTrack(track))
                this.audioPlayer = audioPlayer
            }
        } else if (audio.type == "data") {
            const { audioPlayer, error } = await buildAudioPipeline("data", this.settings, this.logger)

            if (error || !audioPlayer) {
                showErrorPopup("Failed to create audio player")
            } else {
                audioPlayer.mount(this.divElement)
                audio.addReceiveListener((data) => {
                    audioPlayer.decodeAndPlay({
                        durationMicroseconds: 0,
                        timestampMicroseconds: 0,
                        data
                    })
                })
                this.audioPlayer = audioPlayer
            }
        } else {
            this.debugLog(`Cannot find audio pipeline for transport type "${audio.type}"`)
        }

        const videoPipeline = `${this.transport.getChannel(TransportChannelId.HOST_VIDEO).type} (transport) -> ${this.videoRenderer?.implementationName} (renderer)`
        this.debugLog(`Using video pipeline: ${videoPipeline}`)

        const audioPipeline = `${this.transport.getChannel(TransportChannelId.HOST_AUDIO).type} (transport) -> ${this.audioPlayer?.implementationName} (player)`
        this.debugLog(`Using audio pipeline: ${audioPipeline}`)

        this.stats.setVideoPipelineName(videoPipeline)
        this.stats.setAudioPipelineName(audioPipeline)

        return transportCodecSupport
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
