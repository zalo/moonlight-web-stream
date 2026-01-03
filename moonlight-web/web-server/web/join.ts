import "./polyfill/index.js"
import { Api, getApiNoAuth } from "./api.js";
import { Component } from "./component/index.js";
import { showErrorPopup } from "./component/error.js";
import { InfoEvent, Stream } from "./stream/index.js"
import { getModalBackground, showMessage } from "./component/modal/index.js";
import { getSidebarRoot, setSidebar, setSidebarExtended, Sidebar } from "./component/sidebar/index.js";
import { defaultStreamInputConfig, MouseMode, ScreenKeyboardSetVisibleEvent, StreamInputConfig } from "./stream/input.js";
import { defaultSettings, getLocalStreamSettings, Settings } from "./component/settings_menu.js";
import { SelectComponent } from "./component/input.js";
import { LogMessageType, StreamCapabilities, StreamKeys } from "./api_bindings.js";
import { ScreenKeyboard, TextEvent } from "./screen_keyboard.js";
import { streamStatsToText } from "./stream/stats.js";
import { GuestStream } from "./stream/guest.js";

async function startApp() {
    const api = await getApiNoAuth()

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return;
    }

    // Get Room ID via Query
    const queryParams = new URLSearchParams(location.search)

    const roomId = queryParams.get("room")
    const playerName = queryParams.get("name")

    if (roomId == null) {
        await showMessage("No Room ID found. Please use a valid guest link.")
        return
    }

    // event propagation on overlays
    const sidebarRoot = getSidebarRoot()
    if (sidebarRoot) {
        stopPropagationOn(sidebarRoot)
    }

    const modalBackground = getModalBackground()
    if (modalBackground) {
        stopPropagationOn(modalBackground)
    }

    // Start and Mount App
    const app = new GuestViewerApp(api, roomId, playerName)
    app.mount(rootElement)
}

// Prevent starting transition
window.requestAnimationFrame(() => {
    const elements = document.getElementsByClassName("prevent-start-transition")
    while (elements.length > 0) {
        elements.item(0)?.classList.remove("prevent-start-transition")
    }
})

startApp()

class GuestViewerApp implements Component {
    private api: Api

    private sidebar: GuestViewerSidebar

    private div = document.createElement("div")

    private statsDiv = document.createElement("div")
    private stream: GuestStream | null = null

    private settings: Settings

    private inputConfig: StreamInputConfig = defaultStreamInputConfig()
    private previousMouseMode: MouseMode
    private toggleFullscreenWithKeybind: boolean
    private hasShownFullscreenEscapeWarning = false

    constructor(api: Api, roomId: string, playerName: string | null) {
        this.api = api

        // Configure sidebar
        this.sidebar = new GuestViewerSidebar(this)
        setSidebar(this.sidebar)

        // Configure stats element
        this.statsDiv.hidden = true
        this.statsDiv.classList.add("video-stats")

        setInterval(() => {
            const stats = this.getStream()?.getStats()
            if (stats && stats.isEnabled()) {
                this.statsDiv.hidden = false
                const text = streamStatsToText(stats.getCurrentStats())
                this.statsDiv.innerText = text
            } else {
                this.statsDiv.hidden = true
            }
        }, 100)
        this.div.appendChild(this.statsDiv)

        // Configure stream
        const settings = getLocalStreamSettings() ?? defaultSettings()

        let browserWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
        let browserHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)

        this.previousMouseMode = this.inputConfig.mouseMode
        this.toggleFullscreenWithKeybind = settings.toggleFullscreenWithKeybind
        this.startGuestStream(roomId, playerName, settings, [browserWidth, browserHeight])

        this.settings = settings

        // Configure input
        this.addListeners(document)
        this.addListeners(document.getElementById("input") as HTMLDivElement)

        window.addEventListener("blur", () => {
            this.stream?.getInput().raiseAllKeys()
        })
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") {
                this.stream?.getInput().raiseAllKeys()
            }
        })

        document.addEventListener("pointerlockchange", this.onPointerLockChange.bind(this))
        document.addEventListener("fullscreenchange", this.onFullscreenChange.bind(this))

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.stream?.getInput().onGamepadConnect(gamepad)
            }
        }
    }

    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })

        element.addEventListener("mousedown", this.onMouseDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseUp.bind(this), { passive: false })
        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
    }

    private getStreamRect(): DOMRect {
        const renderer = this.stream?.getVideoRenderer()
        if (renderer) {
            return renderer.getRect()
        }
        return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    }

    startGuestStream(roomId: string, playerName: string | null, settings: Settings, viewerScreenSize: [number, number]) {
        document.title = `Joining Room: ${roomId}`

        const stream = new GuestStream(this.api, roomId, playerName, settings, viewerScreenSize)

        stream.addInfoListener(this.onInfo.bind(this))

        stream.mount(this.div)
        this.stream = stream
    }

    private async onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "app") {
            const app = data.app
            document.title = `Stream: ${app.title}`
        } else if (data.type == "connectionComplete") {
            this.sidebar.onCapabilitiesChange(data.capabilities)
        } else if (data.type == "roomJoined") {
            const room = data.room
            const playerSlot = data.playerSlot
            document.title = `${room.app_name} - Player ${playerSlot + 1}`
            this.sidebar.updateRoomInfo(room.room_id, playerSlot, room.players.length, room.max_players, false)
        } else if (data.type == "roomUpdated") {
            const room = data.room
            const playerSlot = this.stream?.getPlayerSlot() ?? 0
            this.sidebar.updateRoomInfo(room.room_id, playerSlot, room.players.length, room.max_players, false)
        } else if (data.type == "roomJoinFailed") {
            await showMessage(`Failed to join room: ${data.reason}`)
        } else if (data.type == "roomClosed") {
            await showMessage("Room closed by host")
            this.sidebar.hideRoomSection()
        } else if (data.type == "guestsKeyboardMouseEnabled") {
            this.sidebar.updateGuestsKeyboardMouseEnabled(data.enabled)
        } else if (data.type == "addDebugLine") {
            if (data.additional?.type === "fatal" || data.additional?.type === "fatalDescription") {
                showErrorPopup(data.line, data.additional?.type === "fatal")
            }
        }
    }

    // Input handlers (same as ViewerApp)
    private onKeyDown(event: KeyboardEvent) {
        if (event.code == "Escape") {
            setSidebarExtended(true)
        }

        if (event.repeat) {
            event.preventDefault()
            return
        }

        if (this.toggleFullscreenWithKeybind && event.code == "F11") {
            event.preventDefault()
            if (this.isFullscreen()) {
                this.exitFullscreen()
            } else {
                this.requestFullscreen()
            }
            return
        }

        this.stream?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.stream?.getInput().onKeyUp(event)
    }

    private onMouseDown(event: MouseEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseDown(event, this.getStreamRect())
        event.stopPropagation()
    }
    private onMouseUp(event: MouseEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseUp(event)
        event.stopPropagation()
    }
    private onMouseMove(event: MouseEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseMove(event, this.getStreamRect())
        event.stopPropagation()
    }
    private onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseWheel(event)
        event.stopPropagation()
    }

    private onTouchStart(event: TouchEvent) {
        event.preventDefault()
        this.stream?.getInput().onTouchStart(event, this.getStreamRect())
        event.stopPropagation()
    }
    private onTouchEnd(event: TouchEvent) {
        event.preventDefault()
        this.stream?.getInput().onTouchEnd(event, this.getStreamRect())
        event.stopPropagation()
    }
    private onTouchMove(event: TouchEvent) {
        event.preventDefault()
        this.stream?.getInput().onTouchMove(event, this.getStreamRect())
        event.stopPropagation()
    }
    private onTouchCancel(event: TouchEvent) {
        event.preventDefault()
        this.stream?.getInput().onTouchCancel(event, this.getStreamRect())
        event.stopPropagation()
    }

    private onGamepadConnect(event: GamepadEvent) {
        this.stream?.getInput().onGamepadConnect(event.gamepad)
    }
    private onGamepadDisconnect(event: GamepadEvent) {
        this.stream?.getInput().onGamepadDisconnect(event)
    }

    private onPointerLockChange() {
        const isLocked = document.pointerLockElement != null
        if (!isLocked && this.inputConfig.mouseMode === "relative") {
            this.inputConfig.mouseMode = this.previousMouseMode
        }
    }

    private onFullscreenChange() {
        if (!this.isFullscreen() && !this.hasShownFullscreenEscapeWarning) {
            this.hasShownFullscreenEscapeWarning = true
        }
    }

    async requestPointerLock(intoRelativeMode: boolean) {
        const input = document.getElementById("input")
        if (input) {
            if (intoRelativeMode) {
                this.previousMouseMode = this.inputConfig.mouseMode
                this.inputConfig.mouseMode = "relative"
            }
            await input.requestPointerLock()
        }
    }

    async requestFullscreen() {
        await document.body.requestFullscreen()
    }
    async exitFullscreen() {
        await document.exitFullscreen()
    }
    isFullscreen(): boolean {
        return document.fullscreenElement != null
    }

    getStream(): GuestStream | null {
        return this.stream
    }

    getInputConfig(): StreamInputConfig {
        return this.inputConfig
    }
    setInputConfig(config: StreamInputConfig) {
        this.inputConfig = config
        this.stream?.getInput().setConfig(config)
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }
}

class GuestViewerSidebar implements Component, Sidebar {
    private app: GuestViewerApp

    private div = document.createElement("div")
    private buttonDiv = document.createElement("div")

    private keyboardButton = document.createElement("button")
    private screenKeyboard = new ScreenKeyboard()

    private lockMouseButton = document.createElement("button")
    private fullscreenButton = document.createElement("button")
    private statsButton = document.createElement("button")

    private mouseMode: SelectComponent
    private touchMode: SelectComponent

    // Room UI elements
    private roomSection = document.createElement("div")
    private roomIdDisplay = document.createElement("div")
    private playerSlotDisplay = document.createElement("div")
    private playerCountDisplay = document.createElement("div")
    private guestsKeyboardMouseStatus = document.createElement("div")

    constructor(app: GuestViewerApp) {
        this.app = app

        this.div.classList.add("sidebar-stream")
        this.buttonDiv.classList.add("sidebar-stream-buttons")
        this.div.appendChild(this.buttonDiv)

        // Pointer Lock
        this.lockMouseButton.innerText = "Lock Mouse"
        this.lockMouseButton.addEventListener("click", async () => {
            await this.app.requestPointerLock(true)
        })
        this.buttonDiv.appendChild(this.lockMouseButton)

        // Keyboard
        this.keyboardButton.innerText = "Keyboard"
        this.keyboardButton.addEventListener("click", async () => {
            setSidebarExtended(false)
            this.screenKeyboard.show()
        })
        this.buttonDiv.appendChild(this.keyboardButton)

        this.screenKeyboard.addKeyDownListener(this.onKeyDown.bind(this))
        this.screenKeyboard.addKeyUpListener(this.onKeyUp.bind(this))
        this.screenKeyboard.addTextListener(this.onText.bind(this))
        this.div.appendChild(this.screenKeyboard.getHiddenElement())

        // Fullscreen
        this.fullscreenButton.innerText = "Fullscreen"
        this.fullscreenButton.addEventListener("click", async () => {
            if (this.app.isFullscreen()) {
                await this.app.exitFullscreen()
            } else {
                await this.app.requestFullscreen()
            }
        })
        this.buttonDiv.appendChild(this.fullscreenButton)

        // Stats
        this.statsButton.innerText = "Stats"
        this.statsButton.addEventListener("click", () => {
            const stats = this.app.getStream()?.getStats()
            if (stats) {
                stats.toggle()
            }
        })
        this.buttonDiv.appendChild(this.statsButton)

        // Mouse Mode
        this.mouseMode = new SelectComponent("mouseMode", [
            { value: "relative", name: "Relative" },
            { value: "follow", name: "Follow" },
            { value: "pointAndDrag", name: "Point and Drag" }
        ], {
            displayName: "Mouse Mode",
            preSelectedOption: this.app.getInputConfig().mouseMode
        })
        this.mouseMode.addChangeListener(this.onMouseModeChange.bind(this))
        this.mouseMode.mount(this.div)

        // Touch Mode
        this.touchMode = new SelectComponent("touchMode", [
            { value: "touch", name: "Touch" },
            { value: "mouseRelative", name: "Relative" },
            { value: "pointAndDrag", name: "Point and Drag" }
        ], {
            displayName: "Touch Mode",
            preSelectedOption: this.app.getInputConfig().touchMode
        })
        this.touchMode.addChangeListener(this.onTouchModeChange.bind(this))
        this.touchMode.mount(this.div)

        // Room section
        this.roomSection.classList.add("sidebar-stream-room")
        this.roomSection.style.display = "none"
        this.div.appendChild(this.roomSection)

        const roomHeader = document.createElement("h4")
        roomHeader.innerText = "Room"
        roomHeader.style.margin = "8px 0 4px 0"
        this.roomSection.appendChild(roomHeader)

        this.roomIdDisplay.classList.add("sidebar-room-info")
        this.roomSection.appendChild(this.roomIdDisplay)

        this.playerSlotDisplay.classList.add("sidebar-room-info")
        this.roomSection.appendChild(this.playerSlotDisplay)

        this.playerCountDisplay.classList.add("sidebar-room-info")
        this.roomSection.appendChild(this.playerCountDisplay)

        this.guestsKeyboardMouseStatus.classList.add("sidebar-room-info")
        this.guestsKeyboardMouseStatus.innerText = "KB/Mouse: Disabled"
        this.roomSection.appendChild(this.guestsKeyboardMouseStatus)
    }

    onCapabilitiesChange(capabilities: StreamCapabilities) {
        this.touchMode.setOptionEnabled("touch", capabilities.touch)
    }

    updateRoomInfo(roomId: string, playerSlot: number, playerCount: number, maxPlayers: number, _isHost: boolean) {
        this.roomSection.style.display = "block"
        this.roomIdDisplay.innerText = `Room: ${roomId}`
        this.playerSlotDisplay.innerText = `You: Player ${playerSlot + 1}`
        this.playerCountDisplay.innerText = `Players: ${playerCount}/${maxPlayers}`
    }

    updateGuestsKeyboardMouseEnabled(enabled: boolean) {
        this.guestsKeyboardMouseStatus.innerText = `KB/Mouse: ${enabled ? "Enabled" : "Disabled"}`
    }

    hideRoomSection() {
        this.roomSection.style.display = "none"
    }

    getScreenKeyboard(): ScreenKeyboard {
        return this.screenKeyboard
    }

    private onText(event: TextEvent) {
        this.app.getStream()?.getInput().sendText(event.detail.text)
    }
    private onKeyDown(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyUp(event)
    }

    private onMouseModeChange() {
        const config = this.app.getInputConfig()
        config.mouseMode = this.mouseMode.getValue() as any
        this.app.setInputConfig(config)
    }

    private onTouchModeChange() {
        const config = this.app.getInputConfig()
        config.touchMode = this.touchMode.getValue() as any
        this.app.setInputConfig(config)
    }

    extended(): void {
        // Called when sidebar is extended
    }
    unextend(): void {
        // Called when sidebar is unextended
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }
}

function stopPropagationOn(element: HTMLElement) {
    element.addEventListener("keydown", (event) => event.stopPropagation())
    element.addEventListener("keyup", (event) => event.stopPropagation())
    element.addEventListener("mousedown", (event) => event.stopPropagation())
    element.addEventListener("mouseup", (event) => event.stopPropagation())
    element.addEventListener("mousemove", (event) => event.stopPropagation())
    element.addEventListener("wheel", (event) => event.stopPropagation())
    element.addEventListener("touchstart", (event) => event.stopPropagation())
    element.addEventListener("touchend", (event) => event.stopPropagation())
    element.addEventListener("touchmove", (event) => event.stopPropagation())
}
