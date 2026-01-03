import { Api } from "../api.js"
import { App, ConnectionStatus, PlayerSlot, RoomInfo, StreamCapabilities, StreamClientMessage, StreamServerMessage, TransportChannelId } from "../api_bindings.js"
import { showErrorPopup } from "../component/error.js"
import { Component } from "../component/index.js"
import { Settings } from "../component/settings_menu.js"
import { AudioPlayer } from "./audio/index.js"
import { buildAudioPipeline } from "./audio/pipeline.js"
import { BIG_BUFFER } from "./buffer.js"
import { defaultStreamInputConfig, StreamInput } from "./input.js"
import { Logger, LogMessageInfo } from "./log.js"
import { gatherPipeInfo, getPipe } from "./pipeline/index.js"
import { StreamStats } from "./stats.js"
import { Transport, TransportShutdown } from "./transport/index.js"
import { WebSocketTransport } from "./transport/web_socket.js"
import { WebRTCTransport } from "./transport/webrtc.js"
import { allVideoCodecs, andVideoCodecs, createSupportedVideoFormatsBits, emptyVideoCodecs, getSelectedVideoCodec, hasAnyCodec, VideoCodecSupport } from "./video.js"
import { VideoRenderer } from "./video/index.js"
import { buildVideoPipeline, VideoPipelineOptions } from "./video/pipeline.js"
import { getStreamerSize, InfoEvent, InfoEventListener } from "./index.js"

function getVideoCodecHint(settings: Settings): VideoCodecSupport {
    let videoCodecHint = emptyVideoCodecs()
    if (settings.videoCodec == "h264") {
        videoCodecHint.H264 = true
        videoCodecHint.H264_HIGH8_444 = true
    } else if (settings.videoCodec == "h265") {
        videoCodecHint.H265 = true
        videoCodecHint.H265_MAIN10 = true
        videoCodecHint.H265_REXT8_444 = true
        videoCodecHint.H265_REXT10_444 = true
    } else if (settings.videoCodec == "av1") {
        videoCodecHint.AV1 = true
        videoCodecHint.AV1_MAIN8 = true
        videoCodecHint.AV1_MAIN10 = true
        videoCodecHint.AV1_REXT8_444 = true
        videoCodecHint.AV1_REXT10_444 = true
    } else if (settings.videoCodec == "auto") {
        videoCodecHint = allVideoCodecs()
    }
    return videoCodecHint
}

function createPrettyList(list: string[]): string {
    return list.map((item, i) => `${i + 1}. ${item}`).join(", ")
}

/**
 * GuestStream - connects to a room as a guest (no authentication required)
 * This is similar to Stream but connects via the /guest/stream endpoint
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

        // No Init message needed - room ID is in URL

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
            const debugLog = message.DebugLog

            this.debugLog(debugLog.message, {
                type: debugLog.ty ?? undefined
            })
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
                this.debugLog(`Video Format ${formatRaw} was not found! Couldn't start stream!`, { type: "fatal" })
                return
            }

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionComplete", capabilities }
            })

            this.eventTarget.dispatchEvent(event)

            this.input.onStreamStart(capabilities, [width, height])

            this.stats.setVideoInfo(format ?? "Unknown", width, height, fps)

            if (!this.audioPlayer) {
                showErrorPopup("Failed to find supported audio player -> audio is missing.")
            }

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
            const code = message.ConnectionTerminated.error_code

            this.debugLog(`ConnectionTerminated with code ${code}`, { type: "fatalDescription" })
        }
        // -- WebRTC Config
        else if (typeof message === "object" && "Setup" in message) {
            const iceServers = message.Setup.ice_servers

            this.iceServers = iceServers

            this.debugLog(`Using WebRTC Ice Servers: ${createPrettyList(
                iceServers.map(server => server.urls).reduce((list, url) => list.concat(url), [])
            )}`)

            await this.startConnection()
        }
        // -- WebRTC
        else if (typeof message === "object" && "WebRtc" in message) {
            const webrtcMessage = message.WebRtc
            if (this.transport instanceof WebRTCTransport) {
                this.transport.onReceiveMessage(webrtcMessage)
            } else {
                this.debugLog(`Received WebRTC message but transport is currently ${this.transport?.implementationName}`)
            }
        }
        // -- Room messages
        else if (typeof message === "object" && "RoomJoined" in message) {
            this.roomInfo = message.RoomJoined.room
            this.playerSlot = message.RoomJoined.player_slot

            this.debugLog(`Joined room: ${this.roomInfo.room_id} - You are Player ${this.playerSlot + 1}`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomJoined", room: this.roomInfo, playerSlot: this.playerSlot }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if (typeof message === "object" && "RoomUpdated" in message) {
            this.roomInfo = message.RoomUpdated.room

            this.debugLog(`Room updated: ${this.roomInfo.players.length} players connected`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomUpdated", room: this.roomInfo }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if (typeof message === "object" && "RoomJoinFailed" in message) {
            this.debugLog(`Failed to join room: ${message.RoomJoinFailed.reason}`, { type: "fatal" })

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomJoinFailed", reason: message.RoomJoinFailed.reason }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if (typeof message === "object" && "PlayerLeft" in message) {
            const slot = message.PlayerLeft.slot

            this.debugLog(`Player ${slot + 1} left the room`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "playerLeft", slot }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if (message === "RoomClosed") {
            this.debugLog(`Room closed by host`, { type: "fatal" })

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomClosed" }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if (typeof message === "object" && "GuestsKeyboardMouseEnabled" in message) {
            this.guestsKeyboardMouseEnabled = message.GuestsKeyboardMouseEnabled.enabled

            this.debugLog(`Guests keyboard/mouse ${this.guestsKeyboardMouseEnabled ? "enabled" : "disabled"}`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "guestsKeyboardMouseEnabled", enabled: this.guestsKeyboardMouseEnabled }
            })
            this.eventTarget.dispatchEvent(event)
        }
    }

    async startConnection() {
        this.debugLog(`Using transport: ${this.settings.dataTransport}`)

        // Guests use WebSocket transport to avoid conflicts with host's WebRTC
        // and to ensure all clients can receive the broadcast video/audio
        if (this.settings.dataTransport == "websocket" || this.settings.dataTransport == "auto") {
            await this.tryWebSocketTransport()
        } else if (this.settings.dataTransport == "webrtc") {
            let shutdownReason = await this.tryWebRTCTransport()
            if (shutdownReason == "failednoconnect") {
                this.debugLog("Failed to establish WebRTC connection. Falling back to Web Socket transport.")
                await this.tryWebSocketTransport()
            }
        }

        this.debugLog("Tried all configured transport options but no connection was possible", { type: "fatal" })
    }

    private transport: Transport | null = null

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

        const result = await (new Promise((resolve, _reject) => {
            transport.onconnect = () => resolve(true)
            transport.onclose = () => resolve(false)
        }))
        this.debugLog(`WebRTC negotiation success: ${result}`)

        if (!result) {
            return "failednoconnect"
        }

        const pipesInfo = await gatherPipeInfo()

        this.logger.debug(`Supported Pipes: {`)
        let isFirst = true
        for (const [key, value] of pipesInfo.entries()) {
            if (isFirst) {
                isFirst = false
            } else {
                this.logger.debug(",")
            }
            this.logger.debug(`${key}: ${value}`)
        }
        this.logger.debug(`}`)

        const videoPipelineOptions: VideoPipelineOptions = {
            widthHint: this.streamerSize[0],
            heightHint: this.streamerSize[1],
            prefer: this.settings.videoPipelinePrefer
        }

        const videoCodecHint = getVideoCodecHint(this.settings)

        const [videoPipe, audioPipe] = await Promise.all([
            buildVideoPipeline(pipesInfo, videoPipelineOptions, videoCodecHint),
            buildAudioPipeline(pipesInfo)
        ])

        this.debugLog(`Selected Video Pipe: ${videoPipe?.pipelineDescription ?? "-"}`)
        this.debugLog(`Selected Audio Pipe: ${audioPipe?.pipelineDescription ?? "-"}`)

        if (!videoPipe) {
            this.debugLog("Failed to select video pipe!", { type: "fatal" })
            return "failednoconnect"
        }

        transport.onvideoframe = (frameData: Uint8Array) => {
            videoPipe.pushFrame(frameData)
        }

        this.videoRenderer = videoPipe.renderer
        videoPipe.renderer.setStatsCallback(this.stats.onVideoFrameRendered.bind(this.stats))

        if (audioPipe) {
            transport.onaudiodata = (audio) => {
                audioPipe.pushAudioPacket(audio)
            }
            this.audioPlayer = audioPipe.audioPlayer
        }

        this.setupPipelinesForTransport(transport)

        const supportedFormats = andVideoCodecs(videoCodecHint, videoPipe.supportedCodecs)

        if (!hasAnyCodec(supportedFormats)) {
            this.debugLog(`Failed to start connection because no codec was found! Supported: ${videoPipe.supportedCodecs}, Hint: ${videoCodecHint}`, { type: "fatal" })
        }

        const rawFormats = createSupportedVideoFormatsBits(supportedFormats)

        this.sendWsMessage({
            GetConnectionConfig: {
                width: this.streamerSize[0],
                height: this.streamerSize[1],
                fps: this.settings.fps,
                supported_video_formats: rawFormats,
                audio_sample_queue_size: this.settings.audioSampleQueueSize,
                video_frame_queue_size: this.settings.videoFrameQueueSize,
            }
        })

        return await transport.waitTillClosed()
    }

    private async tryWebSocketTransport(): Promise<TransportShutdown> {
        this.debugLog("Using WebSocket transport")

        this.sendWsMessage({
            SetTransport: "WebSocket"
        })

        const transport = new WebSocketTransport(this.logger, this.ws)
        this.setTransport(transport)

        const pipesInfo = await gatherPipeInfo()

        const videoPipelineOptions: VideoPipelineOptions = {
            widthHint: this.streamerSize[0],
            heightHint: this.streamerSize[1],
            prefer: this.settings.videoPipelinePrefer
        }

        const videoCodecHint = getVideoCodecHint(this.settings)

        const [videoPipe, audioPipe] = await Promise.all([
            buildVideoPipeline(pipesInfo, videoPipelineOptions, videoCodecHint),
            buildAudioPipeline(pipesInfo)
        ])

        this.debugLog(`Selected Video Pipe: ${videoPipe?.pipelineDescription ?? "-"}`)
        this.debugLog(`Selected Audio Pipe: ${audioPipe?.pipelineDescription ?? "-"}`)

        if (!videoPipe) {
            this.debugLog("Failed to select video pipe!", { type: "fatal" })
            return "failednoconnect"
        }

        transport.onvideoframe = (frameData: Uint8Array) => {
            videoPipe.pushFrame(frameData)
        }

        this.videoRenderer = videoPipe.renderer
        videoPipe.renderer.setStatsCallback(this.stats.onVideoFrameRendered.bind(this.stats))

        if (audioPipe) {
            transport.onaudiodata = (audio) => {
                audioPipe.pushAudioPacket(audio)
            }
            this.audioPlayer = audioPipe.audioPlayer
        }

        this.setupPipelinesForTransport(transport)

        const supportedFormats = andVideoCodecs(videoCodecHint, videoPipe.supportedCodecs)

        if (!hasAnyCodec(supportedFormats)) {
            this.debugLog(`Failed to start connection because no codec was found! Supported: ${videoPipe.supportedCodecs}, Hint: ${videoCodecHint}`, { type: "fatal" })
        }

        const rawFormats = createSupportedVideoFormatsBits(supportedFormats)

        this.sendWsMessage({
            GetConnectionConfig: {
                width: this.streamerSize[0],
                height: this.streamerSize[1],
                fps: this.settings.fps,
                supported_video_formats: rawFormats,
                audio_sample_queue_size: this.settings.audioSampleQueueSize,
                video_frame_queue_size: this.settings.videoFrameQueueSize,
            }
        })

        return await transport.waitTillClosed()
    }

    private setupPipelinesForTransport(transport: Transport) {
        if (this.videoRenderer) {
            this.videoRenderer.mount(this.divElement)
        }

        transport.setupChannelListeners()
    }

    // -- Socket

    private onWsOpen() {
        this.debugLog("WebSocket connected to guest endpoint")
    }

    private onWsClose(event: CloseEvent) {
        this.debugLog(`WebSocket closed: ${event.code} ${event.reason}`)
    }

    private onRawWsMessage(event: MessageEvent<Blob | string>) {
        if (event.data instanceof Blob) {
            // Binary data is handled by transport
            if (this.transport instanceof WebSocketTransport) {
                event.data.arrayBuffer().then((buffer) => {
                    this.transport?.onSocketBinaryMessage(buffer)
                })
            }
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

    // -- Public API

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
