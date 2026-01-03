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

export type ExecutionEnvironment = {
    main: boolean
    worker: boolean
}

export type InfoEvent = CustomEvent<
    { type: "app", app: App } |
    { type: "serverMessage", message: string } |
    { type: "connectionComplete", capabilities: StreamCapabilities } |
    { type: "connectionStatus", status: ConnectionStatus } |
    { type: "addDebugLine", line: string, additional?: LogMessageInfo } |
    { type: "roomCreated", room: RoomInfo, playerSlot: PlayerSlot } |
    { type: "roomJoined", room: RoomInfo, playerSlot: PlayerSlot } |
    { type: "roomUpdated", room: RoomInfo } |
    { type: "roomJoinFailed", reason: string } |
    { type: "playerLeft", slot: PlayerSlot } |
    { type: "roomClosed" } |
    { type: "guestsKeyboardMouseEnabled", enabled: boolean }
>
export type InfoEventListener = (event: InfoEvent) => void

export function getStreamerSize(settings: Settings, viewerScreenSize: [number, number]): [number, number] {
    let width, height
    if (settings.videoSize == "720p") {
        width = 1280
        height = 720
    } else if (settings.videoSize == "1080p") {
        width = 1920
        height = 1080
    } else if (settings.videoSize == "1440p") {
        width = 2560
        height = 1440
    } else if (settings.videoSize == "4k") {
        width = 3840
        height = 2160
    } else if (settings.videoSize == "custom") {
        width = settings.videoSizeCustom.width
        height = settings.videoSizeCustom.height
    } else { // native
        width = viewerScreenSize[0]
        height = viewerScreenSize[1]
    }
    return [width, height]
}

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

export class Stream implements Component {
    private logger: Logger = new Logger()

    private api: Api

    private hostId: number
    private appId: number

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

    constructor(api: Api, hostId: number, appId: number, settings: Settings, viewerScreenSize: [number, number]) {
        this.logger.addInfoListener((info, type) => {
            this.debugLog(info, { type: type ?? undefined })
        })

        this.api = api

        this.hostId = hostId
        this.appId = appId

        this.settings = settings

        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Configure web socket
        const wsApiHost = api.host_url.replace(/^http(s)?:/, "ws$1:")
        // TODO: firstly try out WebTransport
        this.ws = new WebSocket(`${wsApiHost}/host/stream`)
        this.ws.addEventListener("error", this.onError.bind(this))
        this.ws.addEventListener("open", this.onWsOpen.bind(this))
        this.ws.addEventListener("close", this.onWsClose.bind(this))
        this.ws.addEventListener("message", this.onRawWsMessage.bind(this))

        this.sendWsMessage({
            Init: {
                host_id: this.hostId,
                app_id: this.appId,
                video_frame_queue_size: this.settings.videoFrameQueueSize,
                audio_sample_queue_size: this.settings.audioSampleQueueSize,
            }
        })

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
        if ("DebugLog" in message) {
            const debugLog = message.DebugLog

            this.debugLog(debugLog.message, {
                type: debugLog.ty ?? undefined
            })
        } else if ("UpdateApp" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "app", app: message.UpdateApp.app }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("ConnectionComplete" in message) {
            const capabilities = message.ConnectionComplete.capabilities
            const formatRaw = message.ConnectionComplete.format
            const width = message.ConnectionComplete.width
            const height = message.ConnectionComplete.height
            const fps = message.ConnectionComplete.fps

            const audioChannels = message.ConnectionComplete.audio_channels
            const audioSampleRate = message.ConnectionComplete.audio_sample_rate

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

            // we should allow streaming without audio
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
                    channels: audioChannels,
                    sampleRate: audioSampleRate
                })
            ])
        } else if ("ConnectionTerminated" in message) {
            const code = message.ConnectionTerminated.error_code

            this.debugLog(`ConnectionTerminated with code ${code}`, { type: "fatalDescription" })
        }
        // -- WebRTC Config
        else if ("Setup" in message) {
            const iceServers = message.Setup.ice_servers

            this.iceServers = iceServers

            this.debugLog(`Using WebRTC Ice Servers: ${createPrettyList(
                iceServers.map(server => server.urls).reduce((list, url) => list.concat(url), [])
            )}`)

            await this.startConnection()
        }
        // -- WebRTC
        else if ("WebRtc" in message) {
            const webrtcMessage = message.WebRtc
            if (this.transport instanceof WebRTCTransport) {
                this.transport.onReceiveMessage(webrtcMessage)
            } else {
                this.debugLog(`Received WebRTC message but transport is currently ${this.transport?.implementationName}`)
            }
        }
        // -- Room messages
        else if ("RoomCreated" in message) {
            this.roomInfo = message.RoomCreated.room
            this.playerSlot = message.RoomCreated.player_slot

            this.debugLog(`Room created: ${this.roomInfo.room_id} - You are Player ${this.playerSlot[0] + 1} (Host)`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomCreated", room: this.roomInfo, playerSlot: this.playerSlot }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if ("RoomJoined" in message) {
            this.roomInfo = message.RoomJoined.room
            this.playerSlot = message.RoomJoined.player_slot

            this.debugLog(`Joined room: ${this.roomInfo.room_id} - You are Player ${this.playerSlot[0] + 1}`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomJoined", room: this.roomInfo, playerSlot: this.playerSlot }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if ("RoomUpdated" in message) {
            this.roomInfo = message.RoomUpdated.room

            this.debugLog(`Room updated: ${this.roomInfo.players.length} players connected`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomUpdated", room: this.roomInfo }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if ("RoomJoinFailed" in message) {
            this.debugLog(`Failed to join room: ${message.RoomJoinFailed.reason}`, { type: "fatal" })

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomJoinFailed", reason: message.RoomJoinFailed.reason }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if ("PlayerLeft" in message) {
            const slot = message.PlayerLeft.slot

            this.debugLog(`Player ${slot[0] + 1} left the room`)

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "playerLeft", slot }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if ("RoomClosed" in message) {
            this.debugLog(`Room closed by host`, { type: "fatal" })

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "roomClosed" }
            })
            this.eventTarget.dispatchEvent(event)
        }
        else if ("GuestsKeyboardMouseEnabled" in message) {
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

        // Wait for negotiation
        const result = await (new Promise((resolve, _reject) => {
            transport.onconnect = () => resolve(true)
            transport.onclose = () => resolve(false)
        }))
        this.debugLog(`WebRTC negotiation success: ${result}`)

        if (!result) {
            return "failednoconnect"
        }

        // Print pipe support
        const pipesInfo = await gatherPipeInfo()

        this.logger.debug(`Supported Pipes: {`)
        let isFirst = true
        for (const [key, value] of pipesInfo.entries()) {
            this.logger.debug(`${isFirst ? "" : ","}"${getPipe(key)?.name}": ${JSON.stringify(value)}`)
            isFirst = false
        }
        this.logger.debug(`}`)

        const videoCodecSupport = await this.createPipelines()
        if (!videoCodecSupport) {
            this.debugLog("No video pipeline was found for the codec that was specified. If you're unsure which codecs are supported use H264.", { type: "fatalDescription" })

            await transport.close()
            return "failednoconnect"
        }

        await this.startStream(videoCodecSupport)

        return new Promise((resolve, reject) => {
            transport.onclose = (shutdown) => {
                resolve(shutdown)
            }
        })
    }
    private async tryWebSocketTransport() {
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

        await this.startStream(videoCodecSupport)

        return new Promise((resolve, reject) => {
            transport.onclose = (shutdown) => {
                resolve(shutdown)
            }
        })
    }

    private async createPipelines(): Promise<VideoCodecSupport | null> {
        // Create pipelines
        const [supportedVideoCodecs] = await Promise.all([this.createVideoRenderer(), this.createAudioPlayer()])

        const videoPipeline = `${this.transport?.getChannel(TransportChannelId.HOST_VIDEO).type} (transport) -> ${this.videoRenderer?.implementationName} (renderer)`
        this.debugLog(`Using video pipeline: ${videoPipeline}`)

        const audioPipeline = `${this.transport?.getChannel(TransportChannelId.HOST_AUDIO).type} (transport) -> ${this.audioPlayer?.implementationName} (player)`
        this.debugLog(`Using audio pipeline: ${audioPipeline}`)

        this.stats.setVideoPipelineName(videoPipeline)
        this.stats.setAudioPipelineName(audioPipeline)

        return supportedVideoCodecs
    }
    private async createVideoRenderer(): Promise<VideoCodecSupport | null> {
        if (this.videoRenderer) {
            this.debugLog("Found an old video renderer -> cleaning it up")

            this.videoRenderer.unmount(this.divElement)
            this.videoRenderer.cleanup()
            this.videoRenderer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup video without transport")
            return null
        }

        const codecHint = getVideoCodecHint(this.settings)
        this.debugLog(`Codec Hint by the user: ${JSON.stringify(codecHint)}`)

        if (!hasAnyCodec(codecHint)) {
            this.debugLog("Couldn't find any supported video format. Change the codec option to H264 in the settings if you're unsure which codecs are supported.", { type: "fatalDescription" })
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

        let pipelineCodecSupport
        const video = this.transport.getChannel(TransportChannelId.HOST_VIDEO)
        if (video.type == "videotrack") {
            const { videoRenderer, supportedCodecs, error } = await buildVideoPipeline("videotrack", videoSettings, this.logger)

            if (error) {
                return null
            }
            pipelineCodecSupport = supportedCodecs

            videoRenderer.mount(this.divElement)

            video.addTrackListener((track) => {
                videoRenderer.setTrack(track)
            })

            this.videoRenderer = videoRenderer
        } else if (video.type == "data") {
            const { videoRenderer, supportedCodecs, error } = await buildVideoPipeline("data", videoSettings, this.logger)

            if (error) {
                return null
            }
            pipelineCodecSupport = supportedCodecs

            videoRenderer.mount(this.divElement)

            video.addReceiveListener((data) => {
                videoRenderer.submitPacket(data)
            })

            this.videoRenderer = videoRenderer
        } else {
            this.debugLog(`Failed to create video pipeline with transport channel of type ${video.type} (${this.transport.implementationName})`)
            return null
        }

        return pipelineCodecSupport
    }
    private async createAudioPlayer(): Promise<boolean> {
        if (this.audioPlayer) {
            this.debugLog("Found an old audio player -> cleaning it up")

            this.audioPlayer.unmount(this.divElement)
            this.audioPlayer.cleanup()
            this.audioPlayer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup audio without transport")
            return false
        }

        this.transport.setupHostAudio({
            type: ["audiotrack", "data"]
        })

        const audio = this.transport?.getChannel(TransportChannelId.HOST_AUDIO)
        if (audio.type == "audiotrack") {
            const { audioPlayer, error } = await buildAudioPipeline("audiotrack", this.settings)

            if (error) {
                return false
            }

            audioPlayer.mount(this.divElement)

            audio.addTrackListener((track) => audioPlayer.setTrack(track))

            this.audioPlayer = audioPlayer
        } else if (audio.type == "data") {
            const { audioPlayer, error } = await buildAudioPipeline("data", this.settings)

            if (error) {
                return false
            }

            audioPlayer.mount(this.divElement)

            audio.addReceiveListener((data) => {
                audioPlayer.decodeAndPlay({
                    // TODO: fill in duration and timestamp
                    durationMicroseconds: 0,
                    timestampMicroseconds: 0,
                    data
                })
            })

            this.audioPlayer = audioPlayer
        } else {
            this.debugLog(`Cannot find audio pipeline for transport type "${audio.type}"`)
            return false
        }

        return true
    }
    private async startStream(videoCodecSupport: VideoCodecSupport): Promise<void> {
        const message: StreamClientMessage = {
            StartStream: {
                bitrate: this.settings.bitrate,
                packet_size: this.settings.packetSize,
                fps: this.settings.fps,
                width: this.streamerSize[0],
                height: this.streamerSize[1],
                play_audio_local: this.settings.playAudioLocal,
                video_supported_formats: createSupportedVideoFormatsBits(videoCodecSupport),
                video_colorspace: "Rec709",
                video_color_range_full: false,
            }
        }
        this.debugLog(`Starting stream with info: ${JSON.stringify(message)}`)
        this.debugLog(`Stream video codec info: ${JSON.stringify(videoCodecSupport)}`)

        this.sendWsMessage(message)
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }

    getVideoRenderer(): VideoRenderer | null {
        return this.videoRenderer
    }
    getAudioPlayer(): AudioPlayer | null {
        return this.audioPlayer
    }

    // -- Raw Web Socket stuff
    private wsSendBuffer: Array<string> = []

    private onWsOpen() {
        this.debugLog(`Web Socket Open`)

        for (const raw of this.wsSendBuffer.splice(0)) {
            this.ws.send(raw)
        }
    }
    private onWsClose() {
        this.debugLog(`Web Socket Closed`)
    }
    private onError(event: Event) {
        this.debugLog(`Web Socket or WebRtcPeer Error`)

        console.error(`Web Socket or WebRtcPeer Error`, event)
    }

    private sendWsMessage(message: StreamClientMessage) {
        const raw = JSON.stringify(message)
        if (this.ws.readyState == WebSocket.OPEN) {
            this.ws.send(raw)
        } else {
            this.wsSendBuffer.push(raw)
        }
    }
    private onRawWsMessage(event: MessageEvent) {
        const message = event.data
        if (typeof message == "string") {
            const json = JSON.parse(message)

            this.onMessage(json)
        }
    }

    // -- Class Api
    addInfoListener(listener: InfoEventListener) {
        this.eventTarget.addEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }
    removeInfoListener(listener: InfoEventListener) {
        this.eventTarget.removeEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }

    getInput(): StreamInput {
        return this.input
    }
    getStats(): StreamStats {
        return this.stats
    }

    getStreamerSize(): [number, number] {
        return this.streamerSize
    }

    getRoomInfo(): RoomInfo | null {
        return this.roomInfo
    }

    getPlayerSlot(): PlayerSlot | null {
        return this.playerSlot
    }

    isHost(): boolean {
        return this.playerSlot !== null && this.playerSlot[0] === 0
    }

    canUseKeyboardMouse(): boolean {
        if (this.isHost()) {
            return true
        }
        return this.guestsKeyboardMouseEnabled
    }

    getGuestsKeyboardMouseEnabled(): boolean {
        return this.guestsKeyboardMouseEnabled
    }

    /**
     * Host-only: Set whether guests can use keyboard/mouse
     */
    setGuestsKeyboardMouseEnabled(enabled: boolean): void {
        if (!this.isHost()) {
            console.warn("Only the host can change keyboard/mouse permission")
            return
        }
        this.sendWsMessage({
            SetGuestsKeyboardMouseEnabled: {
                enabled
            }
        })
    }

    /**
     * Create a Stream that joins an existing room
     */
    static joinRoom(
        api: Api,
        roomId: string,
        playerName: string | null,
        settings: Settings,
        viewerScreenSize: [number, number]
    ): Stream {
        const stream = new Stream(api, 0, 0, settings, viewerScreenSize)

        // Override the init message with a join room message
        stream.wsSendBuffer.length = 0 // Clear the Init message
        stream.sendWsMessage({
            JoinRoom: {
                room_id: roomId,
                player_name: playerName,
                video_frame_queue_size: settings.videoFrameQueueSize,
                audio_sample_queue_size: settings.audioSampleQueueSize,
            }
        })

        return stream
    }
}

function createPrettyList(list: Array<string>): string {
    let isFirst = true
    let text = "["
    for (const item of list) {
        if (!isFirst) {
            text += ", "
        }
        isFirst = false

        text += item
    }
    text += "]"

    return text
}