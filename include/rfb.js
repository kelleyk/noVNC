/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2012 Joel Martin
 * Copyright (C) 2013 Samuel Mannehed for Cendio AB
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 * TIGHT decoder portion:
 * (c) 2012 Michael Tinglof, Joe Balaz, Les Piech (Mercuri.ca)
 */

/*jslint white: false, browser: true */
/*global window, Util, Display, Keyboard, Mouse, Websock, Websock_native, Base64, DES, Ast2100Decoder, arrayEq */

var RFB;

(function () {
    "use strict";
    RFB = function (defaults) {
        if (!defaults) {
            defaults = {};
        }

        this._rfb_host = '';
        this._rfb_port = 5900;
        this._rfb_password = '';
        this._rfb_path = '';

        this._rfb_state = 'disconnected';
        this._rfb_version = 0;
        this._rfb_max_version = 3.8;
        this._rfb_auth_scheme = '';

        this._rfb_tightvnc = false;
        this._rfb_atenikvm = false;
        this._rfb_openvnc = false;
        this._rfb_xvp_ver = 0;

        // In preference order
        this._encodings = [
            ['COPYRECT',            0x01 ],
            ['TIGHT',               0x07 ],
            ['TIGHT_PNG',           -260 ],
            ['HEXTILE',             0x05 ],
            ['RRE',                 0x02 ],
            ['RAW',                 0x00 ],

            // ATEN iKVM encodings
            ['ATEN_HERMON',         0x59 ],
            ['ATEN_ASTJPEG',        0x58 ],
            ['ATEN_AST2100',        0x57 ],
            ['ATEN_YARKON',         0x60 ],
            ['ATEN_PILOT3',         0x61 ],
            
            ['DesktopSize',         -223 ],
            ['Cursor',              -239 ],

            // Psuedo-encoding settings
            //['JPEG_quality_lo',    -32 ],
            ['JPEG_quality_med',     -26 ],
            //['JPEG_quality_hi',    -23 ],
            //['compress_lo',       -255 ],
            ['compress_hi',         -247 ],
            ['last_rect',           -224 ],
            ['xvp',                 -309 ],
            ['ExtendedDesktopSize', -308 ]
        ];

        //dell uses openVNC, which doesn't send us FBU if we ask for COPYRECT, TIGHT, or TIGHT_PNG first
        // during SetEncodings message to server.
        this._openvnc_encodings = [
            'HEXTILE', 
            'RRE', 
            'RAW', 
            //use all enabled pseudo encodings
            'DesktopSize', 'Cursor', 'JPEG_quality_med', 'compress_hi','last_rect','xvp','ExtendedDesktopSize'
        ];

        this._encHandlers = {};
        this._encNames = {};
        this._encStats = {};

        this._sock = null;              // Websock object
        this._display = null;           // Display object
        this._keyboard = null;          // Keyboard input handler object
        this._mouse = null;             // Mouse input handler object
        this._sendTimer = null;         // Send Queue check timer
        this._disconnTimer = null;      // disconnection timer
        this._msgTimer = null;          // queued handle_msg timer

        // Frame buffer update state
        this._FBU = {
            rects: 0,
            subrects: 0,            // RRE
            lines: 0,               // RAW
            tiles: 0,               // HEXTILE
            aten_len: -1,           // ATEN
            aten_type: -1,          // ATEN
            bytes: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            encoding: 0,
            subencoding: -1,
            background: null,
            zlib: []                // TIGHT zlib streams
        };

        this._pixelFormat = {};
        this._fb_width = 0;
        this._fb_height = 0;
        this._fb_name = "";

        this._destBuff = null;
        this._paletteRawBuff = new Uint8Array(1024);  // 256 * 4 (max palette size * max bytes-per-pixel)
        this._paletteConvertedBuff = new Uint8Array(1024);  // 256 * 4 (max palette size * rgbx bytes-per-pixel)

        this._rre_chunk_sz = 100;

        this._timing = {
            last_fbu: 0,
            fbu_total: 0,
            fbu_total_cnt: 0,
            full_fbu_total: 0,
            full_fbu_cnt: 0,

            fbu_rt_start: 0,
            fbu_rt_total: 0,
            fbu_rt_cnt: 0,
            pixels: 0
        };

        this._supportsSetDesktopSize = false;
        this._screen_id = 0;
        this._screen_flags = 0;

        // Mouse state
        this._mouse_buttonMask = 0;
        this._mouse_arr = [];
        this._viewportDragging = false;
        this._viewportDragPos = {};
        this._viewportHasMoved = false;

        // set the default value on user-facing properties
        Util.set_defaults(this, defaults, {
            'target': 'null',                       // VNC display rendering Canvas object
            'focusContainer': document,             // DOM element that captures keyboard input
            'encrypt': false,                       // Use TLS/SSL/wss encryption
            'convertColor': false,                  // Client will not honor request for native color
            'local_cursor': false,                  // Request locally rendered cursor
            'shared': true,                         // Request shared mode
            'view_only': false,                     // Disable client mouse/keyboard
            'aten_password_sep': ':',               // Separator for ATEN iKVM password fields
            'xvp_password_sep': '@',                // Separator for XVP password fields
            'disconnectTimeout': 3,                 // Time (s) to wait for disconnection
            'wsProtocols': ['binary'],              // Protocols to use in the WebSocket connection
            'repeaterID': '',                       // [UltraVNC] RepeaterID to connect to
            'viewportDrag': false,                  // Move the viewport on mouse drags
            'ast2100_quality': -1,                  // If set, use this quality upon connection to a server using the AST2100 video encoding.  Ranges from 0 (lowest) to 0xB (highest) quality.
            'ast2100_subsamplingMode': -1,          // If set, use this subsampling mode upon connection to a serve rusing the AST2100 video encoding.  The value may either be 444 or 422 (which is really 4:2:0 subsampling).

            // Callback functions
            'onUpdateState': function () { },       // onUpdateState(rfb, state, oldstate, statusMsg): state update/change
            'onPasswordRequired': function () { },  // onPasswordRequired(rfb): VNC password is required
            'onClipboard': function () { },         // onClipboard(rfb, text): RFB clipboard contents received
            'onBell': function () { },              // onBell(rfb): RFB Bell message received
            'onFBUReceive': function () { },        // onFBUReceive(rfb, fbu): RFB FBU received but not yet processed
            'onFBUComplete': function () { },       // onFBUComplete(rfb, fbu): RFB FBU received and processed
            'onFBResize': function () { },          // onFBResize(rfb, width, height): frame buffer resized
            'onDesktopName': function () { },       // onDesktopName(rfb, name): desktop name received
            'onXvpInit': function () { },           // onXvpInit(version): XVP extensions active for this connection
            'ast2100_onVideoSettingsChanged': function () { }
        });

        // main setup
        Util.Debug(">> RFB.constructor");

        // populate encHandlers with bound versions
        Object.keys(RFB.encodingHandlers).forEach(function (encName) {
            this._encHandlers[encName] = RFB.encodingHandlers[encName].bind(this);
        }.bind(this));

        // Create lookup tables based on encoding number
        for (var i = 0; i < this._encodings.length; i++) {
            this._encHandlers[this._encodings[i][1]] = this._encHandlers[this._encodings[i][0]];
            this._encNames[this._encodings[i][1]] = this._encodings[i][0];
            this._encStats[this._encodings[i][1]] = [0, 0];
        }

        // NB: nothing that needs explicit teardown should be done
        // before this point, since this can throw an exception
        try {
            this._display = new Display({target: this._target});
        } catch (exc) {
            Util.Error("Display exception: " + exc);
            throw exc;
        }

        this._keyboard = new Keyboard({target: this._focusContainer,
                                       onKeyPress: this._handleKeyPress.bind(this)});

        this._mouse = new Mouse({target: this._target,
                                 onMouseButton: this._handleMouseButton.bind(this),
                                 onMouseMove: this._handleMouseMove.bind(this),
                                 notify: this._keyboard.sync.bind(this._keyboard)});

        this._sock = new Websock();
        this._sock.on('message', this._handle_message.bind(this));
        this._sock.on('open', function () {
            if (this._rfb_state === 'connect') {
                this._updateState('ProtocolVersion', "Starting VNC handshake");
            } else {
                this._fail("Got unexpected WebSocket connection");
            }
        }.bind(this));
        this._sock.on('close', function (e) {
            Util.Warn("WebSocket on-close event");
            var msg = "";
            if (e.code) {
                msg = " (code: " + e.code;
                if (e.reason) {
                    msg += ", reason: " + e.reason;
                }
                msg += ")";
            }
            if (this._rfb_state === 'disconnect') {
                this._updateState('disconnected', 'VNC disconnected' + msg);
            } else if (this._rfb_state === 'ProtocolVersion') {
                this._fail('Failed to connect to server' + msg);
            } else if (this._rfb_state in {'failed': 1, 'disconnected': 1}) {
                Util.Error("Received onclose while disconnected" + msg);
            } else {
                this._fail("Server disconnected" + msg);
            }
            this._sock.off('close');
        }.bind(this));
        this._sock.on('error', function (e) {
            Util.Warn("WebSocket on-error event");
        });

        this._init_vars();

        var rmode = this._display.get_render_mode();
        if (Websock_native) {
            Util.Info("Using native WebSockets");
            this._updateState('loaded', 'noVNC ready: native WebSockets, ' + rmode);
        } else {
            this._cleanupSocket('fatal');
            throw new Error("WebSocket support is required to use noVNC");
        }

        Util.Debug("<< RFB.constructor");
    };

    RFB.prototype = {
        // Public methods
        connect: function (host, port, password, path) {
            this._rfb_host = host;
            this._rfb_port = port;
            this._rfb_password = (password !== undefined) ? password : "";
            this._rfb_path = (path !== undefined) ? path : "";

            if (!this._rfb_host || !this._rfb_port) {
                return this._fail("Must set host and port");
            }

            this._updateState('connect');
        },

        disconnect: function () {
            this._updateState('disconnect', 'Disconnecting');
            this._sock.off('error');
            this._sock.off('message');
            this._sock.off('open');
        },

        sendPassword: function (passwd) {
            this._rfb_password = passwd;
            this._rfb_state = 'Authentication';
            setTimeout(this._init_msg.bind(this), 1);
        },

        sendCtrlAltDel: function () {
            if (this._rfb_state !== 'normal' || this._view_only) { return false; }
            Util.Info("Sending Ctrl-Alt-Del");

            RFB.messages.keyEvent(this._sock, XK_Control_L, 1);
            RFB.messages.keyEvent(this._sock, XK_Alt_L, 1);
            RFB.messages.keyEvent(this._sock, XK_Delete, 1);
            RFB.messages.keyEvent(this._sock, XK_Delete, 0);
            RFB.messages.keyEvent(this._sock, XK_Alt_L, 0);
            RFB.messages.keyEvent(this._sock, XK_Control_L, 0);

            this._sock.flush();
        },

        xvpOp: function (ver, op) {
            if (this._rfb_xvp_ver < ver) { return false; }
            Util.Info("Sending XVP operation " + op + " (version " + ver + ")");
            this._sock.send_string("\xFA\x00" + String.fromCharCode(ver) + String.fromCharCode(op));
            return true;
        },

        xvpShutdown: function () {
            return this.xvpOp(1, 2);
        },

        xvpReboot: function () {
            return this.xvpOp(1, 3);
        },

        xvpReset: function () {
            return this.xvpOp(1, 4);
        },

        // Send a key press. If 'down' is not specified then send a down key
        // followed by an up key.
        sendKey: function (code, down) {
            if (this._rfb_state !== "normal" || this._view_only) { return false; }
            if (typeof down !== 'undefined') {
                Util.Info("Sending key code (" + (down ? "down" : "up") + "): " + code);
                RFB.messages.keyEvent(this._sock, code, down ? 1 : 0);
            } else {
                Util.Info("Sending key code (down + up): " + code);
                RFB.messages.keyEvent(this._sock, code, 1);
                RFB.messages.keyEvent(this._sock, code, 0);
            }

            this._sock.flush();
        },

        clipboardPasteFrom: function (text) {
            if (this._rfb_state !== 'normal') { return; }
            RFB.messages.clientCutText(this._sock, text);
            this._sock.flush();
        },

        setDesktopSize: function (width, height) {
            if (this._rfb_state !== "normal") { return; }

            if (this._supportsSetDesktopSize) {

                var arr = [251];    // msg-type
                arr.push8(0);       // padding
                arr.push16(width);  // width
                arr.push16(height); // height

                arr.push8(1);       // number-of-screens
                arr.push8(0);       // padding

                // screen array
                arr.push32(this._screen_id);    // id
                arr.push16(0);                  // x-position
                arr.push16(0);                  // y-position
                arr.push16(width);              // width
                arr.push16(height);             // height
                arr.push32(this._screen_flags); // flags

                this._sock.send(arr);
            }
        },


        // Private methods

        _connect: function () {
            Util.Debug(">> RFB.connect");

            var uri;
            if (typeof UsingSocketIO !== 'undefined') {
                uri = 'http';
            } else {
                uri = this._encrypt ? 'wss' : 'ws';
            }

            uri += '://' + this._rfb_host + ':' + this._rfb_port + '/' + this._rfb_path;
            Util.Info("connecting to " + uri);

            this._sock.open(uri, this._wsProtocols);

            Util.Debug("<< RFB.connect");
        },

        _init_vars: function () {
            // reset state
            this._FBU.rects        = 0;
            this._FBU.subrects     = 0;  // RRE and HEXTILE
            this._FBU.lines        = 0;  // RAW
            this._FBU.tiles        = 0;  // HEXTILE
            this._FBU.zlibs        = []; // TIGHT zlib encoders
            this._FBU.aten_len     = -1; // ATEN
            this._FBU.aten_type    = -1; // ATEN
            this._mouse_buttonMask = 0;
            this._mouse_arr        = [];
            this._rfb_tightvnc     = false;
            this._rfb_atenikvm     = false;

            // Clear the per connection encoding stats
            var i;
            for (i = 0; i < this._encodings.length; i++) {
                this._encStats[this._encodings[i][1]][0] = 0;
            }

            for (i = 0; i < 4; i++) {
                this._FBU.zlibs[i] = new inflator.Inflate();
            }
        },

        _print_stats: function () {
            Util.Info("Encoding stats for this connection:");
            var i, s;
            for (i = 0; i < this._encodings.length; i++) {
                s = this._encStats[this._encodings[i][1]];
                if (s[0] + s[1] > 0) {
                    Util.Info("    " + this._encodings[i][0] + ": " + s[0] + " rects");
                }
            }

            Util.Info("Encoding stats since page load:");
            for (i = 0; i < this._encodings.length; i++) {
                s = this._encStats[this._encodings[i][1]];
                Util.Info("    " + this._encodings[i][0] + ": " + s[1] + " rects");
            }
        },

        _cleanupSocket: function (state) {
            if (this._sendTimer) {
                clearInterval(this._sendTimer);
                this._sendTimer = null;
            }

            if (this._msgTimer) {
                clearInterval(this._msgTimer);
                this._msgTimer = null;
            }

            if (this._display && this._display.get_context()) {
                this._keyboard.ungrab();
                this._mouse.ungrab();
                if (state !== 'connect' && state !== 'loaded') {
                    this._display.defaultCursor();
                }
                if (Util.get_logging() !== 'debug' || state === 'loaded') {
                    // Show noVNC logo on load and when disconnected, unless in
                    // debug mode
                    this._display.clear();
                }
            }

            this._sock.close();
        },

        /*
         * Page states:
         *   loaded       - page load, equivalent to disconnected
         *   disconnected - idle state
         *   connect      - starting to connect (to ProtocolVersion)
         *   normal       - connected
         *   disconnect   - starting to disconnect
         *   failed       - abnormal disconnect
         *   fatal        - failed to load page, or fatal error
         *
         * RFB protocol initialization states:
         *   ProtocolVersion
         *   Security
         *   Authentication
         *   password     - waiting for password, not part of RFB
         *   SecurityResult
         *   ClientInitialization - not triggered by server message
         *   ServerInitialization (to normal)
         */
        _updateState: function (state, statusMsg) {
            var oldstate = this._rfb_state;

            if (state === oldstate) {
                // Already here, ignore
                Util.Debug("Already in state '" + state + "', ignoring");
            }

            /*
             * These are disconnected states. A previous connect may
             * asynchronously cause a connection so make sure we are closed.
             */
            if (state in {'disconnected': 1, 'loaded': 1, 'connect': 1,
                          'disconnect': 1, 'failed': 1, 'fatal': 1}) {
                this._cleanupSocket(state);
            }

            if (oldstate === 'fatal') {
                Util.Error('Fatal error, cannot continue');
            }

            var cmsg = typeof(statusMsg) !== 'undefined' ? (" Msg: " + statusMsg) : "";
            var fullmsg = "New state '" + state + "', was '" + oldstate + "'." + cmsg;
            if (state === 'failed' || state === 'fatal') {
                Util.Error(cmsg);
            } else {
                Util.Warn(cmsg);
            }

            if (oldstate === 'failed' && state === 'disconnected') {
                // do disconnect action, but stay in failed state
                this._rfb_state = 'failed';
            } else {
                this._rfb_state = state;
            }

            if (this._disconnTimer && this._rfb_state !== 'disconnect') {
                Util.Debug("Clearing disconnect timer");
                clearTimeout(this._disconnTimer);
                this._disconnTimer = null;
                this._sock.off('close');  // make sure we don't get a double event
            }

            switch (state) {
                case 'normal':
                    if (oldstate === 'disconnected' || oldstate === 'failed') {
                        Util.Error("Invalid transition from 'disconnected' or 'failed' to 'normal'");
                    }
                    break;

                case 'connect':
                    this._init_vars();
                    this._connect();
                    // WebSocket.onopen transitions to 'ProtocolVersion'
                    break;

                case 'disconnect':
                    this._disconnTimer = setTimeout(function () {
                        this._fail("Disconnect timeout");
                    }.bind(this), this._disconnectTimeout * 1000);

                    this._print_stats();

                    // WebSocket.onclose transitions to 'disconnected'
                    break;

                case 'failed':
                    if (oldstate === 'disconnected') {
                        Util.Error("Invalid transition from 'disconnected' to 'failed'");
                    } else if (oldstate === 'normal') {
                        Util.Error("Error while connected.");
                    } else if (oldstate === 'init') {
                        Util.Error("Error while initializing.");
                    }

                    // Make sure we transition to disconnected
                    setTimeout(function () {
                        this._updateState('disconnected');
                    }.bind(this), 50);

                    break;

                default:
                    // No state change action to take
            }

            if (oldstate === 'failed' && state === 'disconnected') {
                this._onUpdateState(this, state, oldstate);
            } else {
                this._onUpdateState(this, state, oldstate, statusMsg);
            }
        },

        _fail: function (msg) {
            this._updateState('failed', msg);
            return false;
        },

        _handle_message: function () {
            if (this._sock.rQlen() === 0) {
                Util.Warn("handle_message called on an empty receive queue");
                return;
            }

            switch (this._rfb_state) {
                case 'disconnected':
                case 'failed':
                    Util.Error("Got data while disconnected");
                    break;
                case 'normal':
                    if (this._normal_msg() && this._sock.rQlen() > 0) {
                        // true means we can continue processing
                        // Give other events a chance to run
                        if (this._msgTimer === null) {
                            Util.Debug("More data to process, creating timer");
                            this._msgTimer = setTimeout(function () {
                                this._msgTimer = null;
                                this._handle_message();
                            }.bind(this), 10);
                        } else {
                            Util.Debug("More data to process, existing timer");
                        }
                    }
                    break;
                default:
                    this._init_msg();
                    break;
            }
        },

        _handleKeyPress: function (keysym, down) {
            if (this._view_only) { return; } // View only, skip keyboard, events
            RFB.messages.keyEvent(this._sock, keysym, down);
            this._sock.flush();
        },

        _handleMouseButton: function (x, y, down, bmask) {
            if (down) {
                this._mouse_buttonMask |= bmask;
            } else {
                this._mouse_buttonMask ^= bmask;
            }

            if (this._viewportDrag) {
                if (down && !this._viewportDragging) {
                    this._viewportDragging = true;
                    this._viewportDragPos = {'x': x, 'y': y};

                    // Skip sending mouse events
                    return;
                } else {
                    this._viewportDragging = false;

                    // If the viewport didn't actually move, then treat as a mouse click event
                    // Send the button down event here, as the button up event is sent at the end of this function
                    if (!this._viewportHasMoved && !this._view_only) {
                        RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), bmask);
                    }
                    this._viewportHasMoved = false;
                }
            }

            if (this._view_only) { return; } // View only, skip mouse events

            if (this._rfb_state !== "normal") { return; }
            RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), this._mouse_buttonMask);
        },

        _handleMouseMove: function (x, y) {
            if (this._viewportDragging) {
                var deltaX = this._viewportDragPos.x - x;
                var deltaY = this._viewportDragPos.y - y;

                // The goal is to trigger on a certain physical width, the
                // devicePixelRatio brings us a bit closer but is not optimal.
                var dragThreshold = 10 * (window.devicePixelRatio || 1);

                if (this._viewportHasMoved || (Math.abs(deltaX) > dragThreshold ||
                                               Math.abs(deltaY) > dragThreshold)) {
                    this._viewportHasMoved = true;

                    this._viewportDragPos = {'x': x, 'y': y};
                    this._display.viewportChangePos(deltaX, deltaY);
                }

                // Skip sending mouse events
                return;
            }

            if (this._view_only) { return; } // View only, skip mouse events

            if (this._rfb_state !== "normal") { return; }
            RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), this._mouse_buttonMask);
        },

        // Message Handlers

        _negotiate_protocol_version: function () {
            if (this._sock.rQlen() < 12) {
                return this._fail("Incomplete protocol version");
            }

            var sversion = this._sock.rQshiftStr(12).substr(4, 7);
            Util.Info("Server ProtocolVersion: " + sversion);
            var is_repeater = 0;
            switch (sversion) {
                case "000.000":  // UltraVNC repeater
                    is_repeater = 1;
                    break;
                case "003.003":
                case "003.006":  // UltraVNC
                case "003.889":  // Apple Remote Desktop
                    this._rfb_version = 3.3;
                    break;
                case "003.007":
                    this._rfb_version = 3.7;
                    break;
                case "003.008":
                case "004.000":  // Intel AMT KVM
                case "004.001":  // RealVNC 4.6
                case "055.008":  // SuperMicro KVM
                    this._rfb_version = 3.8;
                    break;
                default:
                    return this._fail("Invalid server version " + sversion);
            }

            if (is_repeater) {
                var repeaterID = this._repeaterID;
                while (repeaterID.length < 250) {
                    repeaterID += "\0";
                }
                this._sock.send_string(repeaterID);
                return true;
            }

            if (this._rfb_version > this._rfb_max_version) {
                this._rfb_version = this._rfb_max_version;
            }

            // Send updates either at a rate of 1 update per 50ms, or
            // whatever slower rate the network can handle
            this._sendTimer = setInterval(this._sock.flush.bind(this._sock), 50);

            var cversion = "00" + parseInt(this._rfb_version, 10) +
                           ".00" + ((this._rfb_version * 10) % 10);
            // FIXME! We need this for some stupid SuperMicro KVMs
            if (sversion == "055.008") {
		    cversion = sversion;
            }
            this._sock.send_string("RFB " + cversion + "\n");
            this._updateState('Security', 'Sent ProtocolVersion: ' + cversion);
        },

        _negotiate_security: function () {
            if (this._rfb_version >= 3.7) {
                // Server sends supported list, client decides
                var num_types = this._sock.rQshift8();
                if (this._sock.rQwait("security type", num_types, 1)) { return false; }

                if (num_types === 0) {
                    var strlen = this._sock.rQshift32();
                    var reason = this._sock.rQshiftStr(strlen);
                    return this._fail("Security failure: " + reason);
                }

                this._rfb_auth_scheme = 0;
                var types = this._sock.rQshiftBytes(num_types);
                Util.Debug("Server security types: " + types);
                this._rfb_server_supported_security_types = Array.from(types);  // @KK: Deliberately copy-constructed, since the underlying array is reused.
                for (var i = 0; i < types.length; i++) {
                    if (types[i] > this._rfb_auth_scheme && (types[i] <= 16 || types[i] == 22)) {
                        this._rfb_auth_scheme = types[i];
                    }
                }

                if (this._rfb_auth_scheme === 0) {
                    return this._fail("Unsupported security types: " + types);
                }

                this._sock.send([this._rfb_auth_scheme]);
            } else {
                // Server decides
                if (this._sock.rQwait("security scheme", 4)) { return false; }
                this._rfb_auth_scheme = this._sock.rQshift32();
            }

            this._updateState('Authentication', 'Authenticating using scheme: ' + this._rfb_auth_scheme);
            return this._init_msg(); // jump to authentication
        },

        // authentication
        _negotiate_aten_auth: function () {
            var aten_sep = this._aten_password_sep;
            var aten_auth = this._rfb_password.split(aten_sep);
            if (aten_auth.length < 2) {
                this._updateState('password', 'ATEN iKVM credentials required (user' + aten_sep +
                                  'password) -- got only ' + this._rfb_password);
                this._onPasswordRequired(this);
                return false;
            }

            this._rfb_atenikvm = true;

            if (this._rfb_tightvnc) {
                // @KK: N.B.: We've already "skipped" the four bytes that we read into numTunnels.
                this._rfb_tightvnc = false;
            } else {
                this._sock.rQskipBytes(4);
            }

            this._sock.rQskipBytes(16);

            var username = aten_auth[0];
            username += new Array(24 - username.length+1).join("\x00");
            var password = aten_auth.slice(1).join(aten_sep);
            password += new Array(24 - password.length+1).join("\x00");

            this._sock.send_string(username + password);
            this._updateState("SecurityResult");
            return true;
        },

        _negotiate_xvp_auth: function () {
            var xvp_sep = this._xvp_password_sep;
            var xvp_auth = this._rfb_password.split(xvp_sep);
            if (xvp_auth.length < 3) {
                this._updateState('password', 'XVP credentials required (user' + xvp_sep +
                                  'target' + xvp_sep + 'password) -- got only ' + this._rfb_password);
                this._onPasswordRequired(this);
                return false;
            }

            var xvp_auth_str = String.fromCharCode(xvp_auth[0].length) +
                               String.fromCharCode(xvp_auth[1].length) +
                               xvp_auth[0] +
                               xvp_auth[1];
            this._sock.send_string(xvp_auth_str);
            this._rfb_password = xvp_auth.slice(2).join(xvp_sep);
            this._rfb_auth_scheme = 2;
            return this._negotiate_authentication();
        },

        _negotiate_std_vnc_auth: function () {
            if (this._rfb_password.length === 0) {
                // Notify via both callbacks since it's kind of
                // an RFB state change and a UI interface issue
                this._updateState('password', "Password Required");
                this._onPasswordRequired(this);
                return false;
            }

            if (this._sock.rQwait("auth challenge", 16)) { return false; }

            // TODO(directxman12): make genDES not require an Array
            var challenge = Array.prototype.slice.call(this._sock.rQshiftBytes(16));
            var response = RFB.genDES(this._rfb_password, challenge);
            this._sock.send(response);
            this._updateState("SecurityResult");
            return true;
        },

        _negotiate_tight_tunnels: function (numTunnels) {
            // @KK: For a full of known tunnel types, see: https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#tight-security-type
            var clientSupportedTunnelTypes = {
                0: { vendor: 'TGHT', signature: 'NOTUNNEL' }
            };
            var serverSupportedTunnelTypes = {};
            // receive tunnel capabilities
            for (var i = 0; i < numTunnels; i++) {
                var cap_code = this._sock.rQshift32();
                var cap_vendor = this._sock.rQshiftStr(4);
                var cap_signature = this._sock.rQshiftStr(8);
                serverSupportedTunnelTypes[cap_code] = { vendor: cap_vendor, signature: cap_signature };
            }

            // choose the notunnel type
            if (serverSupportedTunnelTypes[0]) {
                if (serverSupportedTunnelTypes[0].vendor != clientSupportedTunnelTypes[0].vendor ||
                    serverSupportedTunnelTypes[0].signature != clientSupportedTunnelTypes[0].signature) {
                    return this._fail("Client's tunnel type had the incorrect vendor or signature");
                }
                this._sock.send([0, 0, 0, 0]);  // use NOTUNNEL
                return false; // wait until we receive the sub auth count to continue
            } else {
                return this._fail("Server wanted tunnels, but doesn't support the notunnel type");
            }
        },

        _negotiate_tight_auth: function () {
            var numTunnels;  // NB(directxman12): this is only in scope within the following block,
                             //                   or if equal to zero (necessary for ATEN iKVM support)
            if (!this._rfb_tightvnc) {  // first pass, do the tunnel negotiation
                if (this._sock.rQwait("num tunnels", 4)) { return false; }
                numTunnels = this._sock.rQshift32();
                // @KK: I can only find about a half-dozen known tunnel types, so TightVNC should be sending a
                // relatively small number here, whereas the ATEN servers send four bytes that, when interpreted as a
                // u32, represent a very large number.  (The condition I've chosen below just checks that the first byte
                // is nonzero.)  Further, TightVNC servers seem to be support both 0x02 and 0x10 security types, whereas
                // ATEN iKVM servers advertise only support for 0x10.  (Are there *other* VNC servers that only support
                // 0x10?)
                if (this._rfb_version === 3.8 && arrayEq(this._rfb_server_supported_security_types, [0x10]) && (numTunnels <= 0 || numTunnels > 0x1000000)) {
                    Util.Info('Detected ATEN iKVM server (using heuristic #0 -- older Winbond/Nuvoton or Renesas BMC?).');
                    return this._negotiate_aten_auth();
                }
                if (numTunnels > 0 && this._sock.rQwait("tunnel capabilities", 16 * numTunnels, 4)) { return false; }

                this._rfb_tightvnc = true;

                if (numTunnels > 0) {
                    this._negotiate_tight_tunnels(numTunnels);
                    return false;  // wait until we receive the sub auth to continue
                }
            }

            // second pass, do the sub-auth negotiation
            if (this._sock.rQwait("sub auth count", 4)) { return false; }
            var subAuthCount = this._sock.rQshift32();
            if (this._sock.rQwait("sub auth capabilities", 16 * subAuthCount, 4)) { return false; }

            // Newer X10 Supermicro motherboards get here.  @KK: If we had trouble with this heuristic matching non-ATEN
            // servers, we could also add the "only security type 0x10 is supported" condition from above.
            if (this._rfb_version === 3.8 && numTunnels === 0 && (subAuthCount === 0 || (subAuthCount & 0xFFFF) == 0x0100)) {
                Util.Info('Detected ATEN iKVM server (using heuristic #1 -- newer AST2400 BMC?).');
                return this._negotiate_aten_auth();
            }

            var clientSupportedTypes = {
                'STDVNOAUTH__': 1,
                'STDVVNCAUTH_': 2
            };

            var serverSupportedTypes = [];

            for (var i = 0; i < subAuthCount; i++) {
                var capNum = this._sock.rQshift32();
                var capabilities = this._sock.rQshiftStr(12);
                serverSupportedTypes.push(capabilities);
            }

            for (var authType in clientSupportedTypes) {
                if (serverSupportedTypes.indexOf(authType) != -1) {
                    this._sock.send([0, 0, 0, clientSupportedTypes[authType]]);

                    switch (authType) {
                        case 'STDVNOAUTH__':  // no auth
                            this._updateState('SecurityResult');
                            return true;
                        case 'STDVVNCAUTH_': // VNC auth
                            this._rfb_auth_scheme = 2;
                            return this._init_msg();
                        default:
                            return this._fail("Unsupported tiny auth scheme: " + authType);
                    }
                }
            }

            this._fail("No supported sub-auth types!");
        },

        _negotiate_authentication: function () {
            switch (this._rfb_auth_scheme) {
                case 0:  // connection failed
                    if (this._sock.rQwait("auth reason", 4)) { return false; }
                    var strlen = this._sock.rQshift32();
                    var reason = this._sock.rQshiftStr(strlen);
                    return this._fail("Auth failure: " + reason);

                case 1:  // no auth
                    if (this._rfb_version >= 3.8) {
                        this._updateState('SecurityResult');
                        return true;
                    }
                    this._updateState('ClientInitialisation', "No auth required");
                    return this._init_msg();

                case 22:  // XVP auth
                    return this._negotiate_xvp_auth();

                case 2:  // VNC authentication
                    return this._negotiate_std_vnc_auth();

                case 16:  // TightVNC Security Type
                    return this._negotiate_tight_auth();

                default:
                    return this._fail("Unsupported auth scheme: " + this._rfb_auth_scheme);
            }
        },

        _handle_security_result: function () {
            if (this._sock.rQwait('VNC auth response ', 4)) { return false; }
            switch (this._sock.rQshift32()) {
                case 0:  // OK
                    this._updateState('ClientInitialisation', 'Authentication OK');
                    return this._init_msg();
                case 1:  // failed
                    if (this._rfb_version >= 3.8) {
                        var length = this._sock.rQshift32();
                        if (this._sock.rQwait("SecurityResult reason", length, 8)) { return false; }
                        var reason = this._sock.rQshiftStr(length);
                        return this._fail(reason);
                    } else {
                        return this._fail("Authentication failure");
                    }
                    return false;
                case 2:
                    return this._fail("Too many auth attempts");
            }
        },

        _negotiate_server_init: function () {
            if (this._sock.rQwait("server initialization", 24)) { return false; }
            if (this._rfb_atenikvm && this._sock.rQwait("ATEN server initialization", 36)) { return false; }

            /* Screen size */
            this._fb_width                = this._sock.rQshift16();
            this._fb_height               = this._sock.rQshift16();
            this._destBuff                = new Uint8Array(this._fb_width * this._fb_height * 4);

            /* PIXEL_FORMAT */
            this._pixelFormat.bpp         = this._sock.rQshift8();
            this._pixelFormat.depth       = this._sock.rQshift8();
            this._pixelFormat.big_endian  = (this._sock.rQshift8() !== 0) ? true : false;
            this._pixelFormat.true_color  = (this._sock.rQshift8() !== 0) ? true : false;

            this._pixelFormat.red_max     = this._sock.rQshift16();
            this._pixelFormat.green_max   = this._sock.rQshift16();
            this._pixelFormat.blue_max    = this._sock.rQshift16();
            this._pixelFormat.red_shift   = this._sock.rQshift8();
            this._pixelFormat.green_shift = this._sock.rQshift8();
            this._pixelFormat.blue_shift  = this._sock.rQshift8();
            this._sock.rQskipBytes(3);  // padding

            // NB(directxman12): we don't want to call any callbacks or print messages until
            //                   *after* we're past the point where we could backtrack

            /* Connection name/title */
            var name_length = this._sock.rQshift32();
            if (this._sock.rQwait('server init name', name_length, 24)) { return false; }
            this._fb_name = Util.decodeUTF8(this._sock.rQshiftStr(name_length));

            if (this._rfb_atenikvm) {
                this._sock.rQskipBytes(8); // unknown
                this._sock.rQskip8(); // IKVMVideoEnable
                this._sock.rQskip8(); // IKVMKMEnable
                this._sock.rQskip8(); // IKVMKickEnable
                this._sock.rQskip8(); // VUSBEnable
            }

            if (this._rfb_tightvnc) {
                if (this._sock.rQwait('TightVNC extended server init header', 8, 24 + name_length)) { return false; }
                // In TightVNC mode, ServerInit message is extended
                var numServerMessages = this._sock.rQshift16();
                var numClientMessages = this._sock.rQshift16();
                var numEncodings = this._sock.rQshift16();
                this._sock.rQskipBytes(2);  // padding

                var totalMessagesLength = (numServerMessages + numClientMessages + numEncodings) * 16;
                if (this._sock.rQwait('TightVNC extended server init header', totalMessagesLength, 32 + name_length)) { return false; }

                // we don't actually do anything with the capability information that TIGHT sends,
                // so we just skip the all of this.

                // TIGHT server message capabilities
                this._sock.rQskipBytes(16 * numServerMessages);

                // TIGHT client message capabilities
                this._sock.rQskipBytes(16 * numClientMessages);

                // TIGHT encoding capabilities
                this._sock.rQskipBytes(16 * numEncodings);
            }

            // NB(directxman12): these are down here so that we don't run them multiple times
            //                   if we backtrack
            Util.Info("Screen: " + this._fb_width + "x" + this._fb_height +
                      ", bpp: " + this._pixelFormat.bpp + ", depth: " + this._pixelFormat.depth +
                      ", big_endian: " + this._pixelFormat.big_endian +
                      ", true_color: " + this._pixelFormat.true_color +
                      ", red_max: " + this._pixelFormat.red_max +
                      ", green_max: " + this._pixelFormat.green_max +
                      ", blue_max: " + this._pixelFormat.blue_max +
                      ", red_shift: " + this._pixelFormat.red_shift +
                      ", green_shift: " + this._pixelFormat.green_shift +
                      ", blue_shift: " + this._pixelFormat.blue_shift);

            // we're past the point where we could backtrack, so it's safe to call this
            this._onDesktopName(this, this._fb_name);

            if (this._fb_name === "Intel(r) AMT KVM") {
                Util.Warn("Intel AMT KVM only supports 8/16 bit depths, using server pixel format");
                this._convertColor = true;
            }
            else if(this._fb_name === "OpenVNC") {
                Util.Warn("OpenVNC will not respond to TIGHT or COPYRECT encodings; will not be sent to server.");
                this._rfb_openvnc = true;
            }

            // ATEN 'wisdom' from chicken-aten-ikvm:lens/lens.rb
            // tested against the following Supermicro motherboards
            // (use 'dmidecode -s baseboard-product-name' for model):
            // - X7SPA-F
            // - X8DTL
            // - X8SIE-F
            // - X9SCL/X9SCM
            // - X9SCM-F
            // - X9DRD-iF
            // - X9SRE/X9SRE-3F/X9SRi/X9SRi-3F
            // - X9DRL-3F/X9DRL-6F
            // - X10SLD
            //
            // Supported using the ATEN "AST2100" encoding (0x57 / 87):
            // - X10SL7-F
            // - X10SLD-F
            // - X10SLM-F
            // - X10SLE
            //
            // Simply does not work:
            // Hermon (WPMC450) [hangs at login]:
            // - X7SB3-F
            // - X8DTU-F
            // - X8STi-3F
            // Peppercon (Raritan/Kira100) [connection refused]:
            // - X7SBi
            //
            // Thanks to Brian Rak and Erik Smit for testing
            if (this._rfb_atenikvm) {
                // we do not know the resolution till the first fbupdate so go large
                // although, not necessary, saves a pointless full screen refresh
                this._fb_width                = RFB.ATEN_INIT_WIDTH;
                this._fb_height               = RFB.ATEN_INIT_HEIGHT;

                // TODO: @KK: This message (and this block of code) is part of the original ATEN "HERMON" (0x59)
                //     support.  The "AST2100" (0x57) encoding delivers RGB888 color.  I suppose that we should update this
                //     somehow?  What effect does it have?
                // lies about what it supports
                Util.Warn("ATEN iKVM lies and only does 15 bit depth with RGB555");
                this._convertColor            = true;
                this._pixelFormat.bpp         = 16;
                this._pixelFormat.depth       = 15;
                this._pixelFormat.red_max     = (1 << 5) - 1;
                this._pixelFormat.green_max   = (1 << 5) - 1;
                this._pixelFormat.blue_max    = (1 << 5) - 1;
                this._pixelFormat.red_shift   = 10;
                this._pixelFormat.green_shift = 5;
                this._pixelFormat.blue_shift  = 0;

                // changes to protocol format
                RFB.messages.keyEvent = RFB.messages.atenKeyEvent;
                RFB.messages.pointerEvent = RFB.messages.atenPointerEvent;
            }

            if (this._convertColor)
                this._display.set_true_color(this._pixelFormat.true_color);
            this._display.resize(this._fb_width, this._fb_height);
            this._onFBResize(this, this._fb_width, this._fb_height);
            this._keyboard.grab();
            this._mouse.grab();

            // only send if not native, and we think the server will honor the conversion
            if (!this._convertColor) {
                if (this._pixelFormat.big_endian !== false ||
                        this._pixelFormat.red_max !== 255 ||
                        this._pixelFormat.green_max !== 255 ||
                        this._pixelFormat.blue_max !== 255 ||
                        this._pixelFormat.red_shift !== 16 ||
                        this._pixelFormat.green_shift !== 8 ||
                        this._pixelFormat.blue_shift !== 0 ||
                        !(this._pixelFormat.bpp === 32 &&
                            this._pixelFormat.depth === 24 &&
                            this._pixelFormat.true_color === true) ||
                        !(this._pixelFormat.bpp === 8 &&
                            this._pixelFormat.depth === 8 &&
                            this._pixelFormat.true_color === false)) {
                    this._pixelFormat.big_endian = false;
                    this._pixelFormat.red_max = 255;
                    this._pixelFormat.green_max = 255;
                    this._pixelFormat.blue_max = 255;
                    this._pixelFormat.red_shift = 16;
                    this._pixelFormat.green_shift = 8;
                    this._pixelFormat.blue_shift = 0;
                    if (this._pixelFormat.true_color) {
                        this._pixelFormat.bpp = 32;
                        this._pixelFormat.depth = 24;
                    } else {
                        this._pixelFormat.bpp = 8;
                        this._pixelFormat.depth = 8;
                    }
                    RFB.messages.pixelFormat(this._sock, this._pixelFormat);
                } else {
                    Util.Warn("Server pixel format matches our preferred native, disabling color conversion");
                    this._convertColor = false;
                }
            }

            this._pixelFormat.Bpp = this._pixelFormat.bpp / 8;
            this._pixelFormat.Bdepth = Math.ceil(this._pixelFormat.depth / 8);

            if (this._pixelFormat.bpp < this._pixelFormat.depth) {
                return this._fail('server claims greater depth than bpp');
            }

            var max_depth = Math.ceil(Math.log(this._pixelFormat.red_max)/Math.LN2) +
                            Math.ceil(Math.log(this._pixelFormat.green_max)/Math.LN2) +
                            Math.ceil(Math.log(this._pixelFormat.blue_max)/Math.LN2);

            if (this._pixelFormat.true_color && this._pixelFormat.depth > max_depth) {
                return this._fail('server claims greater depth than sum of RGB maximums');
            }

            RFB.messages.clientEncodings(this._sock, this._encodings, this._local_cursor, this._pixelFormat._true_color,
                //If using openVNC, use the encodings that the server likes as a filter; else all allowed (empty filter)
                this._rfb_openvnc ? this._openvnc_encodings : []
            );
            RFB.messages.fbUpdateRequests(this._sock, this._display.getCleanDirtyReset(), this._fb_width, this._fb_height);

            this._timing.fbu_rt_start = (new Date()).getTime();
            this._timing.pixels = 0;
            this._sock.flush();

            if (this._encrypt) {
                this._updateState('normal', 'Connected (encrypted) to: ' + this._fb_name);
            } else {
                this._updateState('normal', 'Connected (unencrypted) to: ' + this._fb_name);
            }
        },

        _init_msg: function () {
            switch (this._rfb_state) {
                case 'ProtocolVersion':
                    return this._negotiate_protocol_version();

                case 'Security':
                    return this._negotiate_security();

                case 'Authentication':
                    return this._negotiate_authentication();

                case 'SecurityResult':
                    return this._handle_security_result();

                case 'ClientInitialisation':
                    this._sock.send([this._shared ? 1 : 0]); // ClientInitialisation
                    this._updateState('ServerInitialisation', "Authentication OK");
                    return true;

                case 'ServerInitialisation':
                    return this._negotiate_server_init();
            }
        },

        _handle_set_colour_map_msg: function () {
            Util.Debug("SetColorMapEntries");
            this._sock.rQskip8();  // Padding

            var first_colour = this._sock.rQshift16();
            var num_colours = this._sock.rQshift16();
            if (this._sock.rQwait('SetColorMapEntries', num_colours * 6, 6)) { return false; }

            for (var c = 0; c < num_colours; c++) {
                var red = parseInt(this._sock.rQshift16() / 256, 10);
                var green = parseInt(this._sock.rQshift16() / 256, 10);
                var blue = parseInt(this._sock.rQshift16() / 256, 10);
                this._display.set_colourMap([blue, green, red], first_colour + c);
            }
            Util.Debug("colourMap: " + this._display.get_colourMap());
            Util.Info("Registered " + num_colours + " colourMap entries");

            return true;
        },

        _handle_server_cut_text: function () {
            Util.Debug("ServerCutText");
            if (this._sock.rQwait("ServerCutText header", 7, 1)) { return false; }
            this._sock.rQskipBytes(3);  // Padding
            var length = this._sock.rQshift32();
            if (this._sock.rQwait("ServerCutText", length, 8)) { return false; }

            var text = this._sock.rQshiftStr(length);
            this._onClipboard(this, text);

            return true;
        },

        _handle_xvp_msg: function () {
            if (this._sock.rQwait("XVP version and message", 3, 1)) { return false; }
            this._sock.rQskip8();  // Padding
            var xvp_ver = this._sock.rQshift8();
            var xvp_msg = this._sock.rQshift8();

            switch (xvp_msg) {
                case 0:  // XVP_FAIL
                    this._updateState(this._rfb_state, "Operation Failed");
                    break;
                case 1:  // XVP_INIT
                    this._rfb_xvp_ver = xvp_ver;
                    Util.Info("XVP extensions enabled (version " + this._rfb_xvp_ver + ")");
                    this._onXvpInit(this._rfb_xvp_ver);
                    break;
                default:
                    this._fail("Disconnected: illegal server XVP message " + xvp_msg);
                    break;
            }

            return true;
        },

        _normal_msg: function () {
            var msg_type;

            if (this._FBU.rects > 0) {
                msg_type = 0;
            } else {
                msg_type = this._sock.rQshift8();
            }

            if (this._rfb_atenikvm) {
                switch (msg_type) {
                    case 4:  // Front Ground Event
                        Util.Debug("ATEN iKVM Front Ground Event");
                        this._sock.rQskipBytes(20);
                        return true;

                    case 22:  // Keep Alive Event
                        Util.Debug("ATEN iKVM Keep Alive Event");
                        this._sock.rQskipBytes(1);
                        return true;

                    case 51:  // Video Get Info
                        Util.Debug("ATEN iKVM Video Get Info");
                        this._sock.rQskipBytes(4);
                        return true;

                    case 55:  // Mouse Get Info
                        Util.Debug("ATEN iKVM Mouse Get Info");
                        this._sock.rQskipBytes(2);
                        return true;

                    case 57:  // Session Message
                        Util.Debug("ATEN iKVM Session Message");
                        this._sock.rQskipBytes(4); // u32
                        this._sock.rQskipBytes(4); // u32
                        this._sock.rQskipBytes(256);
                        return true;

                    case 60:  // Get Viewer Lang
                        Util.Debug("ATEN iKVM Get Viewer Lang");
                        this._sock.rQskipBytes(8);
                        return true;
                }
            }

            switch (msg_type) {
                case 0:  // FramebufferUpdate
                    var ret = this._framebufferUpdate();
                    if (ret) {
                        RFB.messages.fbUpdateRequests(this._sock, this._display.getCleanDirtyReset(), this._fb_width, this._fb_height);
                        this._sock.flush();
                    }
                    return ret;

                case 1:  // SetColorMapEntries
                    return this._handle_set_colour_map_msg();

                case 2:  // Bell
                    Util.Debug("Bell");
                    this._onBell(this);
                    return true;

                case 3:  // ServerCutText
                    return this._handle_server_cut_text();

                case 250:  // XVP
                    return this._handle_xvp_msg();

                default:
                    this._fail("Disconnected: illegal server message type " + msg_type);
                    Util.Debug("sock.rQslice(0, 30): " + this._sock.rQslice(0, 30));
                    return true;
            }
        },

        _framebufferUpdate: function () {
            var ret = true;
            var now;

            if (this._FBU.rects === 0) {
                if (this._sock.rQwait("FBU header", 3, 1)) { return false; }
                this._sock.rQskip8();  // Padding
                this._FBU.rects = this._sock.rQshift16();
                this._FBU.bytes = 0;
                this._timing.cur_fbu = 0;
                if (this._timing.fbu_rt_start > 0) {
                    now = (new Date()).getTime();
                    Util.Info("First FBU latency: " + (now - this._timing.fbu_rt_start));
                }
            }

            while (this._FBU.rects > 0) {
                if (this._rfb_state !== "normal") { return false; }

                if (this._sock.rQwait("FBU", this._FBU.bytes)) { return false; }
                if (this._FBU.bytes === 0) {
                    if (this._sock.rQwait("rect header", 12)) { return false; }
                    /* New FramebufferUpdate */

                    var hdr = this._sock.rQshiftBytes(12);
                    this._FBU.x        = (hdr[0] << 8) + hdr[1];
                    this._FBU.y        = (hdr[2] << 8) + hdr[3];
                    this._FBU.width    = (hdr[4] << 8) + hdr[5];
                    this._FBU.height   = (hdr[6] << 8) + hdr[7];
                    this._FBU.encoding = parseInt((hdr[8] << 24) + (hdr[9] << 16) +
                                                  (hdr[10] << 8) + hdr[11], 10);

                    this._onFBUReceive(this,
                        {'x': this._FBU.x, 'y': this._FBU.y,
                         'width': this._FBU.width, 'height': this._FBU.height,
                         'encoding': this._FBU.encoding,
                         'encodingName': this._encNames[this._FBU.encoding]});

                    if (!this._encNames[this._FBU.encoding]) {
                        this._fail("Disconnected: unsupported encoding " +
                                   this._FBU.encoding);
                        return false;
                    }

                    // @KK: We should probably modify this condition so that this can only happen when we are using the
                    // ATEN_HERMON encoding, and not other ATEN encodings. --
                    // ATEN uses 0x00 even when it is meant to be 0x59
                    if (this._rfb_atenikvm && this._FBU.encoding === 0x00) {
                        this._FBU.encoding = 0x59;
                    }
                }

                this._timing.last_fbu = (new Date()).getTime();

                // @KK: This is where the encoding handler is invoked.
                var handler = this._encHandlers[this._FBU.encoding];
                /*
                try {
                    //ret = this._encHandlers[this._FBU.encoding]();
                    ret = handler();
                } catch (ex)  {
                    console.log("missed " + this._FBU.encoding + ": " + handler);
                    ret = this._encHandlers[this._FBU.encoding]();
                }
                 */
                ret = handler();

                now = (new Date()).getTime();
                this._timing.cur_fbu += (now - this._timing.last_fbu);

                if (ret) {
                    this._encStats[this._FBU.encoding][0]++;
                    this._encStats[this._FBU.encoding][1]++;
                    this._timing.pixels += this._FBU.width * this._FBU.height;
                }

                if (this._timing.pixels >= (this._fb_width * this._fb_height)) {
                    if ((this._FBU.width === this._fb_width && this._FBU.height === this._fb_height) ||
                        this._timing.fbu_rt_start > 0) {
                        this._timing.full_fbu_total += this._timing.cur_fbu;
                        this._timing.full_fbu_cnt++;
                        Util.Info("Timing of full FBU, curr: " +
                                  this._timing.cur_fbu + ", total: " +
                                  this._timing.full_fbu_total + ", cnt: " +
                                  this._timing.full_fbu_cnt + ", avg: " +
                                  (this._timing.full_fbu_total / this._timing.full_fbu_cnt));
                    }

                    if (this._timing.fbu_rt_start > 0) {
                        var fbu_rt_diff = now - this._timing.fbu_rt_start;
                        this._timing.fbu_rt_total += fbu_rt_diff;
                        this._timing.fbu_rt_cnt++;
                        Util.Info("full FBU round-trip, cur: " +
                                  fbu_rt_diff + ", total: " +
                                  this._timing.fbu_rt_total + ", cnt: " +
                                  this._timing.fbu_rt_cnt + ", avg: " +
                                  (this._timing.fbu_rt_total / this._timing.fbu_rt_cnt));
                        this._timing.fbu_rt_start = 0;
                    }
                }

                if (!ret) { return ret; }  // need more data
            }

            this._onFBUComplete(this,
                    {'x': this._FBU.x, 'y': this._FBU.y,
                     'width': this._FBU.width, 'height': this._FBU.height,
                     'encoding': this._FBU.encoding,
                     'encodingName': this._encNames[this._FBU.encoding]});

            return true;  // We finished this FBU
        },

        // like _convert_color, but always outputs bgr, and for only one pixel
        _convert_one_color: function (arr, offset, Bpp) {
            if (Bpp === undefined) {
                Bpp = this._pixelFormat.Bpp;
            }

            if (offset === undefined) {
                offset = 0;
            }

            if (!this._convertColor ||
                    // HACK? Xtightvnc needs this and I have no idea why
                    (this._FBU.encoding === 0x07 && this._pixelFormat.depth === 24)) {
                if (Bpp === 4) {
                    return [arr[offset + 0], arr[offset + 1], arr[offset + 2], arr[offset + 3]];
                } else if (Bpp === 3) {
                    return [arr[offset + 2], arr[offset + 1], arr[offset + 0]];
                } else {
                    Util.Error('convert color disabled, but Bpp is not 3 or 4!');
                }
            }

            var bgr = new Array(3);

            var redMult = 256/(this._pixelFormat.red_max + 1);
            var greenMult = 256/(this._pixelFormat.red_max + 1);
            var blueMult = 256/(this._pixelFormat.blue_max + 1);

            var pix = 0;
            for (var k = 0; k < Bpp; k++) {
                if (this._pixelFormat.big_endian) {
                    pix = (pix << 8) | arr[k + offset];
                } else {
                    pix = (arr[k + offset] << (k*8)) | pix;
                }
            }

            bgr[2] = ((pix >>> this._pixelFormat.red_shift) & this._pixelFormat.red_max) * redMult;
            bgr[1] = ((pix >>> this._pixelFormat.green_shift) & this._pixelFormat.green_max) * greenMult;
            bgr[0] = ((pix >>> this._pixelFormat.blue_shift) & this._pixelFormat.blue_max) * blueMult;

            return bgr;
        },

        // takes a byte stream in the pixel format, and outputs rgbx into the output buffer
        _convert_color: function (out_arr, in_arr, Bpp) {
            if (Bpp === undefined) {
                Bpp = this._pixelFormat.Bpp;
            }

            if (!this._convertColor ||
                    // HACK? Xtightvnc needs this and I have no idea why
                    (this._FBU.encoding === 0x07 && this._pixelFormat.depth === 24)) {
                if (Bpp !== 4 && Bpp !== 3) {
                    Util.Error('convert color disabled, but Bpp is not 3 or 4!');
                } else {
                    out_arr.set(in_arr);
                    return;
                }
            }

            var redMult = 256/(this._pixelFormat.red_max + 1);
            var greenMult = 256/(this._pixelFormat.red_max + 1);
            var blueMult = 256/(this._pixelFormat.blue_max + 1);

            for (var i = 0, j = 0; i < in_arr.length; i += Bpp, j += 4) {
                var pix = 0;

                for (var k = 0; k < Bpp; k++) {
                    if (this._pixelFormat.big_endian) {
                        pix = (pix << 8) | in_arr[i + k];
                    } else {
                        pix = (in_arr[i + k] << (k*8)) | pix;
                    }
                }

                out_arr[j] = ((pix >>> this._pixelFormat.red_shift) & this._pixelFormat.red_max) * redMult;
                out_arr[j + 1] = ((pix >>> this._pixelFormat.green_shift) & this._pixelFormat.green_max) * greenMult;
                out_arr[j + 2] = ((pix >>> this._pixelFormat.blue_shift) & this._pixelFormat.blue_max) * blueMult;
                out_arr[j + 3] = 255;
            }
        },
    };

    Util.make_properties(RFB, [
        ['target', 'wo', 'dom'],                // VNC display rendering Canvas object
        ['focusContainer', 'wo', 'dom'],        // DOM element that captures keyboard input
        ['encrypt', 'rw', 'bool'],              // Use TLS/SSL/wss encryption
        ['convertColor', 'rw', 'bool'],         // Client will not honor request for native color
        ['local_cursor', 'rw', 'bool'],         // Request locally rendered cursor
        ['shared', 'rw', 'bool'],               // Request shared mode
        ['view_only', 'rw', 'bool'],            // Disable client mouse/keyboard
        ['aten_password_sep', 'rw', 'str'],     // Separator for ATEN iKVM password fields
        ['xvp_password_sep', 'rw', 'str'],      // Separator for XVP password fields
        ['disconnectTimeout', 'rw', 'int'],     // Time (s) to wait for disconnection
        ['wsProtocols', 'rw', 'arr'],           // Protocols to use in the WebSocket connection
        ['repeaterID', 'rw', 'str'],            // [UltraVNC] RepeaterID to connect to
        ['viewportDrag', 'rw', 'bool'],         // Move the viewport on mouse drags
        ['ast2100_quality', 'rw','int'],                 // 0-100, force quality mode for ATEN AST2100 server
        ['ast2100_subsamplingMode', 'rw', 'int'],          // Use advanced subampling fot ATEN AST2100 server

        // Callback functions
        ['onUpdateState', 'rw', 'func'],        // onUpdateState(rfb, state, oldstate, statusMsg): RFB state update/change
        ['onPasswordRequired', 'rw', 'func'],   // onPasswordRequired(rfb): VNC password is required
        ['onClipboard', 'rw', 'func'],          // onClipboard(rfb, text): RFB clipboard contents received
        ['onBell', 'rw', 'func'],               // onBell(rfb): RFB Bell message received
        ['onFBUReceive', 'rw', 'func'],         // onFBUReceive(rfb, fbu): RFB FBU received but not yet processed
        ['onFBUComplete', 'rw', 'func'],        // onFBUComplete(rfb, fbu): RFB FBU received and processed
        ['onFBResize', 'rw', 'func'],           // onFBResize(rfb, width, height): frame buffer resized
        ['onDesktopName', 'rw', 'func'],        // onDesktopName(rfb, name): desktop name received
        ['onXvpInit', 'rw', 'func'],            // onXvpInit(version): XVP extensions active for this connection
        ['ast2100_onVideoSettingsChanged', 'rw', 'func'], // onVideoSettingsChanged(videoSettings): AST2100 video quality settings changed in latest FBU
    ]);

    RFB.prototype.set_local_cursor = function (cursor) {
        if (!cursor || (cursor in {'0': 1, 'no': 1, 'false': 1})) {
            this._local_cursor = false;
            this._display.disableLocalCursor(); //Only show server-side cursor
        } else {
            if (this._display.get_cursor_uri()) {
                this._local_cursor = true;
            } else {
                Util.Warn("Browser does not support local cursor");
                this._display.disableLocalCursor();
            }
        }
    };

    RFB.prototype.get_display = function () { return this._display; };
    RFB.prototype.get_keyboard = function () { return this._keyboard; };
    RFB.prototype.get_mouse = function () { return this._mouse; };

    // ATEN iKVM doesn't send the resolution until the first refresh, so start big
    // to avoid a repaint
    RFB.ATEN_INIT_WIDTH = 10000;
    RFB.ATEN_INIT_HEIGHT = 10000;

    // Class Methods
    RFB.messages = {
        keyEvent: function (sock, keysym, down) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 4;  // msg-type
            buff[offset + 1] = down;

            buff[offset + 2] = 0;
            buff[offset + 3] = 0;

            buff[offset + 4] = (keysym >> 24);
            buff[offset + 5] = (keysym >> 16);
            buff[offset + 6] = (keysym >> 8);
            buff[offset + 7] = keysym;

            sock._sQlen += 8;
        },

        atenKeyEvent: function (sock, keysym, down) {
            var ks = XK2HID[keysym];
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 4;
            buff[offset + 1] = 0;
            buff[offset + 2] = down;

            buff[offset + 3] = 0;
            buff[offset + 4] = 0;
            
            buff[offset + 5] = (ks >> 24);
            buff[offset + 6] = (ks >> 16);
            buff[offset + 7] = (ks >> 8);
            buff[offset + 8] = ks;

            buff[offset + 9] = 0;
            buff[offset + 10] = 0;
            buff[offset + 11] = 0;
            buff[offset + 12] = 0;

            buff[offset + 13] = 0;
            buff[offset + 14] = 0;
            buff[offset + 15] = 0;
            buff[offset + 16] = 0;

            buff[offset + 17] = 0;

            sock._sQlen += 18;
        },

        atenPointerEvent: function (sock, x, y, mask) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 5;
            buff[offset + 1] = 0;
            buff[offset + 2] = mask;

            buff[offset + 3] = x >> 8;
            buff[offset + 4] = x;
            
            buff[offset + 5] = y >> 8;
            buff[offset + 6] = y;

            buff[offset + 7] = 0;
            buff[offset + 8] = 0;
            buff[offset + 9] = 0;
            buff[offset + 10] = 0;

            buff[offset + 11] = 0;
            buff[offset + 12] = 0;
            buff[offset + 13] = 0;
            buff[offset + 14] = 0;

            buff[offset + 15] = 0;
            buff[offset + 16] = 0;

            buff[offset + 17] = 0;

            sock._sQlen += 18;
        },

        atenChangeVideoSettings: function (sock, lumaQt, chromaQt, subsamplingMode) {
            if (!inRangeIncl(lumaQt, 0, 0xB))
                throw 'Bad value: must have 0 <= lumaQt <= 0xB';
            if (!inRangeIncl(chromaQt, 0, 0xB))
                throw 'Bad value: must have 0 <= chromaQt <= 0xB';
            if (subsamplingMode != 422 && subsamplingMode != 444)
                throw 'Bad value: subsamplingMode must be one of 444, 422';

            var buf = sock._sQ;
            var offset = sock._sQlen;

            buf[offset] = 0x32;
            buf[offset + 1] = lumaQt;
            buf[offset + 2] = chromaQt;
            buf[offset + 3] = subsamplingMode >>> 8;
            buf[offset + 4] = subsamplingMode;

            sock._sQlen += 5;
        },

        pointerEvent: function (sock, x, y, mask) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 5; // msg-type

            buff[offset + 1] = mask;

            buff[offset + 2] = x >> 8;
            buff[offset + 3] = x;

            buff[offset + 4] = y >> 8;
            buff[offset + 5] = y;

            sock._sQlen += 6;
        },

        // TODO(directxman12): make this unicode compatible?
        clientCutText: function (sock, text) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 6; // msg-type

            buff[offset + 1] = 0; // padding
            buff[offset + 2] = 0; // padding
            buff[offset + 3] = 0; // padding

            var n = text.length;

            buff[offset + 4] = n >> 24;
            buff[offset + 5] = n >> 16;
            buff[offset + 6] = n >> 8;
            buff[offset + 7] = n;

            for (var i = 0; i < n; i++) {
                buff[offset + 8 + i] =  text.charCodeAt(i);
            }

            sock._sQlen += 8 + n;
        },

        pixelFormat: function (sock, pf) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 0;  // msg-type

            buff[offset + 1] = 0; // padding
            buff[offset + 2] = 0; // padding
            buff[offset + 3] = 0; // padding

            buff[offset + 4] = pf.bpp;                 // bits-per-pixel
            buff[offset + 5] = pf.depth;               // depth
            buff[offset + 6] = pf.big_endian ? 1 : 0;  // big-endian
            buff[offset + 7] = pf.true_color ? 1 : 0;  // true-color

            buff[offset + 8] = (pf.red_max >> 8) & 0xFF;    // red-max
            buff[offset + 9] = pf.red_max & 0xFF;           // red-max

            buff[offset + 10] = (pf.green_max >> 8) & 0xFF;   // green-max
            buff[offset + 11] = pf.green_max & 0xFF;          // green-max

            buff[offset + 12] = (pf.blue_max >> 8) & 0xFF;    // blue-max
            buff[offset + 13] = (pf.blue_max) & 0xFF;         // blue-max

            buff[offset + 14] = pf.red_shift;     // red-shift
            buff[offset + 15] = pf.green_shift;   // green-shift
            buff[offset + 16] = pf.blue_shift;    // blue-shift

            buff[offset + 17] = 0;   // padding
            buff[offset + 18] = 0;   // padding
            buff[offset + 19] = 0;   // padding

            sock._sQlen += 20;
        },

        clientEncodings: function (sock, encodings, local_cursor, true_color, filter_encodings) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 2; // msg-type
            buff[offset + 1] = 0; // padding

            // offset + 2 and offset + 3 are encoding count

            var i, j = offset + 4, cnt = 0;
            for (i = 0; i < encodings.length; i++) {
                if (encodings[i][0] === "Cursor" && !local_cursor) {
                    Util.Debug("Skipping Cursor pseudo-encoding");
                } else if(filter_encodings.length > 0 && filter_encodings.indexOf(encodings[i][0]) == -1){
                    //use filter if any are present; else use all - used for OpenVNC
                    Util.Debug("Skipping " + encodings[i][0] + ", is not in filtered list.");
                } else if (encodings[i][0] === "TIGHT" && !true_color) {
                    // TODO: remove this when we have tight+non-true-color
                    Util.Warn("Skipping tight as it is only supported with true color");
                } else {
                    var enc = encodings[i][1];
                    buff[j] = enc >> 24;
                    buff[j + 1] = enc >> 16;
                    buff[j + 2] = enc >> 8;
                    buff[j + 3] = enc;

                    j += 4;
                    cnt++;
                }
            }

            buff[offset + 2] = cnt >> 8;
            buff[offset + 3] = cnt;

            sock._sQlen += j - offset;
        },

        fbUpdateRequests: function (sock, cleanDirty, fb_width, fb_height) {
            var offsetIncrement = 0;

            var cb = cleanDirty.cleanBox;
            var w, h;
            if (cb.w > 0 && cb.h > 0) {
                w = typeof cb.w === "undefined" ? fb_width : cb.w;
                h = typeof cb.h === "undefined" ? fb_height : cb.h;
                // Request incremental for clean box
                RFB.messages.fbUpdateRequest(sock, 1, cb.x, cb.y, w, h);
            }

            for (var i = 0; i < cleanDirty.dirtyBoxes.length; i++) {
                var db = cleanDirty.dirtyBoxes[i];
                // Force all (non-incremental) for dirty box
                w = typeof db.w === "undefined" ? fb_width : db.w;
                h = typeof db.h === "undefined" ? fb_height : db.h;
                RFB.messages.fbUpdateRequest(sock, 0, db.x, db.y, w, h);
            }
        },

        fbUpdateRequest: function (sock, incremental, x, y, w, h) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            if (typeof(x) === "undefined") { x = 0; }
            if (typeof(y) === "undefined") { y = 0; }

            buff[offset] = 3;  // msg-type
            buff[offset + 1] = incremental;

            buff[offset + 2] = (x >> 8) & 0xFF;
            buff[offset + 3] = x & 0xFF;

            buff[offset + 4] = (y >> 8) & 0xFF;
            buff[offset + 5] = y & 0xFF;

            buff[offset + 6] = (w >> 8) & 0xFF;
            buff[offset + 7] = w & 0xFF;

            buff[offset + 8] = (h >> 8) & 0xFF;
            buff[offset + 9] = h & 0xFF;

            sock._sQlen += 10;
        }
    };

    RFB.genDES = function (password, challenge) {
        var passwd = [];
        for (var i = 0; i < password.length; i++) {
            passwd.push(password.charCodeAt(i));
        }
        return (new DES(passwd)).encrypt(challenge);
    };

    RFB.extract_data_uri = function (arr) {
        return ";base64," + Base64.encode(arr);
    };

    RFB.encodingHandlers = {
        RAW: function () {
            if (this._FBU.lines === 0) {
                this._FBU.lines = this._FBU.height;
            }

            this._FBU.bytes = this._FBU.width * this._pixelFormat.Bpp;  // at least a line
            if (this._sock.rQwait("RAW", this._FBU.bytes)) { return false; }
            var cur_y = this._FBU.y + (this._FBU.height - this._FBU.lines);
            var curr_height = Math.min(this._FBU.lines,
                                       Math.floor(this._sock.rQlen() / (this._FBU.width * this._pixelFormat.Bpp)));

            // NB(directxman12): renderQ_push automatically clones the data is we have to push
            //                   to the render queue
            this._convert_color(this._destBuff, this._sock.rQshiftBytes(curr_height * this._FBU.width * this._pixelFormat.Bpp));
            this._display.blitImage(this._FBU.x, cur_y, this._FBU.width, curr_height, this._destBuff, 0, this._convertColor || this._pixelFormat.Bpp === 3, false);

            this._FBU.lines -= curr_height;

            if (this._FBU.lines > 0) {
                this._FBU.bytes = this._FBU.width * this._pixelFormat.Bpp;  // At least another line
            } else {
                this._FBU.rects--;
                this._FBU.bytes = 0;
            }

            return true;
        },

        COPYRECT: function () {
            this._FBU.bytes = 4;
            if (this._sock.rQwait("COPYRECT", 4)) { return false; }
            this._display.copyImage(this._sock.rQshift16(), this._sock.rQshift16(),
                                    this._FBU.x, this._FBU.y, this._FBU.width,
                                    this._FBU.height);

            this._FBU.rects--;
            this._FBU.bytes = 0;
            return true;
        },

        RRE: function () {
            var color;
            if (this._FBU.subrects === 0) {
                this._FBU.bytes = 4 + this._pixelFormat.Bpp;
                if (this._sock.rQwait("RRE", 4 + this._pixelFormat.Bpp)) { return false; }
                this._FBU.subrects = this._sock.rQshift32();
                color = this._convert_one_color(this._sock.rQshiftBytes(this._pixelFormat.Bpp));  // Background
                this._display.fillRect(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, color);
            }

            while (this._FBU.subrects > 0 && this._sock.rQlen() >= (this._pixelFormat.Bpp + 8)) {
                color = this._convert_one_color(this._sock.rQshiftBytes(this._pixelFormat.Bpp));
                var x = this._sock.rQshift16();
                var y = this._sock.rQshift16();
                var width = this._sock.rQshift16();
                var height = this._sock.rQshift16();
                this._display.fillRect(this._FBU.x + x, this._FBU.y + y, width, height, color);
                this._FBU.subrects--;
            }

            if (this._FBU.subrects > 0) {
                var chunk = Math.min(this._rre_chunk_sz, this._FBU.subrects);
                this._FBU.bytes = (this._pixelFormat.Bpp + 8) * chunk;
            } else {
                this._FBU.rects--;
                this._FBU.bytes = 0;
            }

            return true;
        },

        HEXTILE: function () {
            var rQ = this._sock.get_rQ();
            var rQi = this._sock.get_rQi();

            if (this._FBU.tiles === 0) {
                this._FBU.tiles_x = Math.ceil(this._FBU.width / 16);
                this._FBU.tiles_y = Math.ceil(this._FBU.height / 16);
                this._FBU.total_tiles = this._FBU.tiles_x * this._FBU.tiles_y;
                this._FBU.tiles = this._FBU.total_tiles;
            }

            while (this._FBU.tiles > 0) {
                this._FBU.bytes = 1;
                if (this._sock.rQwait("HEXTILE subencoding", this._FBU.bytes)) { return false; }
                var subencoding = rQ[rQi];  // Peek
                if (subencoding > 30) {  // Raw
                    this._fail("Disconnected: illegal hextile subencoding " + subencoding);
                    return false;
                }

                var subrects = 0;
                var curr_tile = this._FBU.total_tiles - this._FBU.tiles;
                var tile_x = curr_tile % this._FBU.tiles_x;
                var tile_y = Math.floor(curr_tile / this._FBU.tiles_x);
                var x = this._FBU.x + tile_x * 16;
                var y = this._FBU.y + tile_y * 16;
                var w = Math.min(16, (this._FBU.x + this._FBU.width) - x);
                var h = Math.min(16, (this._FBU.y + this._FBU.height) - y);

                // Figure out how much we are expecting
                if (subencoding & 0x01) {  // Raw
                    this._FBU.bytes += w * h * this._pixelFormat.Bpp;
                } else {
                    if (subencoding & 0x02) {  // Background
                        this._FBU.bytes += this._pixelFormat.Bpp;
                    }
                    if (subencoding & 0x04) {  // Foreground
                        this._FBU.bytes += this._pixelFormat.Bpp;
                    }
                    if (subencoding & 0x08) {  // AnySubrects
                        this._FBU.bytes++;  // Since we aren't shifting it off
                        if (this._sock.rQwait("hextile subrects header", this._FBU.bytes)) { return false; }
                        subrects = rQ[rQi + this._FBU.bytes - 1];  // Peek
                        if (subencoding & 0x10) {  // SubrectsColoured
                            this._FBU.bytes += subrects * (this._pixelFormat.Bpp + 2);
                        } else {
                            this._FBU.bytes += subrects * 2;
                        }
                    }
                }

                if (this._sock.rQwait("hextile", this._FBU.bytes)) { return false; }

                // We know the encoding and have a whole tile
                this._FBU.subencoding = rQ[rQi];
                rQi++;
                if (this._FBU.subencoding === 0) {
                    if (this._FBU.lastsubencoding & 0x01) {
                        // Weird: ignore blanks are RAW
                        Util.Debug("     Ignoring blank after RAW");
                    } else {
                        this._display.fillRect(x, y, w, h, this._FBU.background);
                    }
                } else if (this._FBU.subencoding & 0x01) {  // Raw
                    // NB(directxman12): renderQ_push automatically clones the data is we have to push
                    //                   to the render queue
                    this._convert_color(this._destBuff, new Uint8Array(rQ.buffer, rQi, this._FBU.bytes - 1));
                    this._display.blitImage(x, y, w, h, this._destBuff, 0, this._convertColor || this._pixelFormat.Bpp === 3, false);
                    rQi += this._FBU.bytes - 1;
                } else {
                    if (this._FBU.subencoding & 0x02) {  // Background
                        this._FBU.background = this._convert_one_color(rQ, rQi);
                        rQi += this._pixelFormat.Bpp;
                    }
                    if (this._FBU.subencoding & 0x04) {  // Foreground
                        this._FBU.foreground = this._convert_one_color(rQ, rQi);
                        rQi += this._pixelFormat.Bpp;
                    }

                    this._display.startTile(x, y, w, h, this._FBU.background);
                    if (this._FBU.subencoding & 0x08) {  // AnySubrects
                        subrects = rQ[rQi];
                        rQi++;

                        for (var s = 0; s < subrects; s++) {
                            var color;
                            if (this._FBU.subencoding & 0x10) {  // SubrectsColoured
                                color = this._convert_one_color(rQ, rQi);
                                rQi += this._pixelFormat.Bpp;
                            } else {
                                color = this._FBU.foreground;
                            }
                            var xy = rQ[rQi];
                            rQi++;
                            var sx = (xy >> 4);
                            var sy = (xy & 0x0f);

                            var wh = rQ[rQi];
                            rQi++;
                            var sw = (wh >> 4) + 1;
                            var sh = (wh & 0x0f) + 1;

                            this._display.subTile(sx, sy, sw, sh, color);
                        }
                    }
                    this._display.finishTile();
                }
                this._sock.set_rQi(rQi);
                this._FBU.lastsubencoding = this._FBU.subencoding;
                this._FBU.bytes = 0;
                this._FBU.tiles--;
            }

            if (this._FBU.tiles === 0) {
                this._FBU.rects--;
            }

            return true;
        },

        getTightCLength: function (arr) {
            var header = 1, data = 0;
            data += arr[0] & 0x7f;
            if (arr[0] & 0x80) {
                header++;
                data += (arr[1] & 0x7f) << 7;
                if (arr[1] & 0x80) {
                    header++;
                    data += arr[2] << 14;
                }
            }
            return [header, data];
        },

        display_tight: function (isTightPNG) {
            if (this._pixelFormat.Bdepth === 1) {
                this._fail("Tight protocol handler only implements true color mode");
            }

            this._FBU.bytes = 1;  // compression-control byte
            if (this._sock.rQwait("TIGHT compression-control", this._FBU.bytes)) { return false; }

            var checksum = function (data) {
                var sum = 0;
                for (var i = 0; i < data.length; i++) {
                    sum += data[i];
                    if (sum > 65536) sum -= 65536;
                }
                return sum;
            };

            var resetStreams = 0;
            var streamId = -1;
            var decompress = function (data, expected) {
                for (var i = 0; i < 4; i++) {
                    if ((resetStreams >> i) & 1) {
                        this._FBU.zlibs[i].reset();
                        console.debug('RESET!');
                        Util.Info("Reset zlib stream " + i);
                    }
                }

                //var uncompressed = this._FBU.zlibs[streamId].uncompress(data, 0);
                var uncompressed = this._FBU.zlibs[streamId].inflate(data, true, expected);
                /*if (uncompressed.status !== 0) {
                    Util.Error("Invalid data in zlib stream");
                }*/

                //return uncompressed.data;
                return uncompressed;
            }.bind(this);

            var indexedToRGBX2Color = function (data, palette, width, height) {
                // Convert indexed (palette based) image data to RGB
                // TODO: reduce number of calculations inside loop
                var dest = this._destBuff;
                var w = Math.floor((width + 7) / 8);
                var w1 = Math.floor(width / 8);

                /*for (var y = 0; y < height; y++) {
                    var b, x, dp, sp;
                    var yoffset = y * width;
                    var ybitoffset = y * w;
                    var xoffset, targetbyte;
                    for (x = 0; x < w1; x++) {
                        xoffset = yoffset + x * 8;
                        targetbyte = data[ybitoffset + x];
                        for (b = 7; b >= 0; b--) {
                            dp = (xoffset + 7 - b) * 3;
                            sp = (targetbyte >> b & 1) * 3;
                            dest[dp] = palette[sp];
                            dest[dp + 1] = palette[sp + 1];
                            dest[dp + 2] = palette[sp + 2];
                        }
                    }

                    xoffset = yoffset + x * 8;
                    targetbyte = data[ybitoffset + x];
                    for (b = 7; b >= 8 - width % 8; b--) {
                        dp = (xoffset + 7 - b) * 3;
                        sp = (targetbyte >> b & 1) * 3;
                        dest[dp] = palette[sp];
                        dest[dp + 1] = palette[sp + 1];
                        dest[dp + 2] = palette[sp + 2];
                    }
                }*/

                for (var y = 0; y < height; y++) {
                    var b, x, dp, sp;
                    for (x = 0; x < w1; x++) {
                        for (b = 7; b >= 0; b--) {
                            dp = (y * width + x * 8 + 7 - b) * 4;
                            sp = (data[y * w + x] >> b & 1) * 3;
                            dest[dp] = palette[sp];
                            dest[dp + 1] = palette[sp + 1];
                            dest[dp + 2] = palette[sp + 2];
                            dest[dp + 3] = 255;
                        }
                    }

                    for (b = 7; b >= 8 - width % 8; b--) {
                        dp = (y * width + x * 8 + 7 - b) * 4;
                        sp = (data[y * w + x] >> b & 1) * 3;
                        dest[dp] = palette[sp];
                        dest[dp + 1] = palette[sp + 1];
                        dest[dp + 2] = palette[sp + 2];
                        dest[dp + 3] = 255;
                    }
                }

                return dest;
            }.bind(this);

            var indexedToRGBX = function (data, palette, width, height) {
                // Convert indexed (palette based) image data to RGB
                var dest = this._destBuff;
                var total = width * height * 4;
                for (var i = 0, j = 0; i < total; i += 4, j++) {
                    var sp = data[j] * 3;
                    dest[i] = palette[sp];
                    dest[i + 1] = palette[sp + 1];
                    dest[i + 2] = palette[sp + 2];
                    dest[i + 3] = 255;
                }

                return dest;
            }.bind(this);

            var rQi = this._sock.get_rQi();
            var rQ = this._sock.rQwhole();
            var cmode, data;
            var cl_header, cl_data;

            var handlePalette = function () {
                var numColors = rQ[rQi + 2] + 1;
                var paletteSize = numColors * this._pixelFormat.Bdepth;
                this._FBU.bytes += paletteSize;
                if (this._sock.rQwait("TIGHT palette " + cmode, this._FBU.bytes)) { return false; }

                var bpp = (numColors <= 2) ? 1 : 8;
                var rowSize = Math.floor((this._FBU.width * bpp + 7) / 8);
                var raw = false;
                if (rowSize * this._FBU.height < 12) {
                    raw = true;
                    cl_header = 0;
                    cl_data = rowSize * this._FBU.height;
                    //clength = [0, rowSize * this._FBU.height];
                } else {
                    // begin inline getTightCLength (returning two-item arrays is bad for performance with GC)
                    var cl_offset = rQi + 3 + paletteSize;
                    cl_header = 1;
                    cl_data = 0;
                    cl_data += rQ[cl_offset] & 0x7f;
                    if (rQ[cl_offset] & 0x80) {
                        cl_header++;
                        cl_data += (rQ[cl_offset + 1] & 0x7f) << 7;
                        if (rQ[cl_offset + 1] & 0x80) {
                            cl_header++;
                            cl_data += rQ[cl_offset + 2] << 14;
                        }
                    }
                    // end inline getTightCLength
                }

                this._FBU.bytes += cl_header + cl_data;
                if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) { return false; }

                // Shift ctl, filter id, num colors, palette entries, and clength off
                this._sock.rQskipBytes(3);
                this._sock.rQshiftTo(this._paletteRawBuff, paletteSize);
                this._convert_color(this._paletteConvertedBuff, this._paletteRawBuff, this._pixelFormat.Bdepth);
                this._sock.rQskipBytes(cl_header);

                if (raw) {
                    data = this._sock.rQshiftBytes(cl_data);
                } else {
                    data = decompress(this._sock.rQshiftBytes(cl_data), rowSize * this._FBU.height);
                }

                // Convert indexed (palette based) image data to RGB
                var rgbx;
                if (numColors == 2) {
                    rgbx = indexedToRGBX2Color(data, this._paletteConvertedBuff, this._FBU.width, this._FBU.height);
                    this._display.blitRgbxImage(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, rgbx, 0, false);
                } else {
                    rgbx = indexedToRGBX(data, this._paletteConvertedBuff, this._FBU.width, this._FBU.height);
                    this._display.blitRgbxImage(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, rgbx, 0, false);
                }


                return true;
            }.bind(this);

            var handleCopy = function () {
                var raw = false;
                var uncompressedSize = this._FBU.width * this._FBU.height * this._pixelFormat.Bdepth;
                if (uncompressedSize < 12) {
                    raw = true;
                    cl_header = 0;
                    cl_data = uncompressedSize;
                } else {
                    // begin inline getTightCLength (returning two-item arrays is for peformance with GC)
                    var cl_offset = rQi + 1;
                    cl_header = 1;
                    cl_data = 0;
                    cl_data += rQ[cl_offset] & 0x7f;
                    if (rQ[cl_offset] & 0x80) {
                        cl_header++;
                        cl_data += (rQ[cl_offset + 1] & 0x7f) << 7;
                        if (rQ[cl_offset + 1] & 0x80) {
                            cl_header++;
                            cl_data += rQ[cl_offset + 2] << 14;
                        }
                    }
                    // end inline getTightCLength
                }
                this._FBU.bytes = 1 + cl_header + cl_data;
                if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) { return false; }

                // Shift ctl, clength off
                this._sock.rQshiftBytes(1 + cl_header);

                if (raw) {
                    data = this._sock.rQshiftBytes(cl_data);
                } else {
                    data = decompress(this._sock.rQshiftBytes(cl_data), uncompressedSize);
                }

                this._convert_color(this._destBuff, data, this._pixelFormat.Bdepth);
                this._display.blitImage(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, this._destBuff, 0, this._convertColor || this._pixelFormat.Bpp === 3, false);

                return true;
            }.bind(this);

            var ctl = this._sock.rQpeek8();

            // Keep tight reset bits
            resetStreams = ctl & 0xF;

            // Figure out filter
            ctl = ctl >> 4;
            streamId = ctl & 0x3;

            if (ctl === 0x08)       cmode = "fill";
            else if (ctl === 0x09)  cmode = "jpeg";
            else if (ctl === 0x0A)  cmode = "png";
            else if (ctl & 0x04)    cmode = "filter";
            else if (ctl < 0x04)    cmode = "copy";
            else return this._fail("Illegal tight compression received, ctl: " + ctl);

            if (isTightPNG && (cmode === "filter" || cmode === "copy")) {
                return this._fail("filter/copy received in tightPNG mode");
            }

            switch (cmode) {
                // fill use fb_depth because TPIXELs drop the padding byte
                case "fill":  // TPIXEL
                    this._FBU.bytes += this._pixelFormat.Bdepth;
                    break;
                case "jpeg":  // max clength
                    this._FBU.bytes += 3;
                    break;
                case "png":  // max clength
                    this._FBU.bytes += 3;
                    break;
                case "filter":  // filter id + num colors if palette
                    this._FBU.bytes += 2;
                    break;
                case "copy":
                    break;
            }

            if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) { return false; }

            // Determine FBU.bytes
            switch (cmode) {
                case "fill":
                    // skip ctl byte
                    var color = this._convert_one_color(rQ, rQi + 1, this._pixelFormat.Bdepth);
                    this._display.fillRect(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, color, false);
                    this._sock.rQskipBytes(this._pixelFormat.Bdepth + 1);
                    break;
                case "png":
                case "jpeg":
                    // begin inline getTightCLength (returning two-item arrays is for peformance with GC)
                    var cl_offset = rQi + 1;
                    cl_header = 1;
                    cl_data = 0;
                    cl_data += rQ[cl_offset] & 0x7f;
                    if (rQ[cl_offset] & 0x80) {
                        cl_header++;
                        cl_data += (rQ[cl_offset + 1] & 0x7f) << 7;
                        if (rQ[cl_offset + 1] & 0x80) {
                            cl_header++;
                            cl_data += rQ[cl_offset + 2] << 14;
                        }
                    }
                    // end inline getTightCLength
                    this._FBU.bytes = 1 + cl_header + cl_data;  // ctl + clength size + jpeg-data
                    if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) { return false; }

                    // We have everything, render it
                    this._sock.rQskipBytes(1 + cl_header);  // shift off clt + compact length
                    var img = new Image();
                    img.src = "data: image/" + cmode +
                        RFB.extract_data_uri(this._sock.rQshiftBytes(cl_data));
                    this._display.renderQ_push({
                        'type': 'img',
                        'img': img,
                        'x': this._FBU.x,
                        'y': this._FBU.y
                    });
                    img = null;
                    break;
                case "filter":
                    var filterId = rQ[rQi + 1];
                    if (filterId === 1) {
                        if (!handlePalette()) { return false; }
                    } else {
                        // Filter 0, Copy could be valid here, but servers don't send it as an explicit filter
                        // Filter 2, Gradient is valid but not use if jpeg is enabled
                        // TODO(directxman12): why aren't we just calling '_fail' here
                        throw new Error("Unsupported tight subencoding received, filter: " + filterId);
                    }
                    break;
                case "copy":
                    if (!handleCopy()) { return false; }
                    break;
            }


            this._FBU.bytes = 0;
            this._FBU.rects--;

            return true;
        },

        TIGHT: function () { return this._encHandlers.display_tight(false); },
        TIGHT_PNG: function () { return this._encHandlers.display_tight(true); },

        last_rect: function () {
            this._FBU.rects = 0;
            return true;
        },

        handle_FB_resize: function () {
            this._fb_width = this._FBU.width;
            this._fb_height = this._FBU.height;
            this._destBuff = new Uint8Array(this._fb_width * this._fb_height * 4);
            this._display.resize(this._fb_width, this._fb_height);
            this._onFBResize(this, this._fb_width, this._fb_height);
            this._timing.fbu_rt_start = (new Date()).getTime();

            this._FBU.bytes = 0;
            this._FBU.rects -= 1;
            return true;
        },

        ExtendedDesktopSize: function () {
            this._FBU.bytes = 1;
            if (this._sock.rQwait("ExtendedDesktopSize", this._FBU.bytes)) { return false; }

            this._supportsSetDesktopSize = true;
            var number_of_screens = this._sock.rQpeek8();

            this._FBU.bytes = 4 + (number_of_screens * 16);
            if (this._sock.rQwait("ExtendedDesktopSize", this._FBU.bytes)) { return false; }

            this._sock.rQskipBytes(1);  // number-of-screens
            this._sock.rQskipBytes(3);  // padding

            for (var i = 0; i < number_of_screens; i += 1) {
                // Save the id and flags of the first screen
                if (i === 0) {
                    this._screen_id = this._sock.rQshiftBytes(4);    // id
                    this._sock.rQskipBytes(2);                       // x-position
                    this._sock.rQskipBytes(2);                       // y-position
                    this._sock.rQskipBytes(2);                       // width
                    this._sock.rQskipBytes(2);                       // height
                    this._screen_flags = this._sock.rQshiftBytes(4); // flags
                } else {
                    this._sock.rQskipBytes(16);
                }
            }

            /*
             * The x-position indicates the reason for the change:
             *
             *  0 - server resized on its own
             *  1 - this client requested the resize
             *  2 - another client requested the resize
             */

            // We need to handle errors when we requested the resize.
            if (this._FBU.x === 1 && this._FBU.y !== 0) {
                var msg = "";
                // The y-position indicates the status code from the server
                switch (this._FBU.y) {
                case 1:
                    msg = "Resize is administratively prohibited";
                    break;
                case 2:
                    msg = "Out of resources";
                    break;
                case 3:
                    msg = "Invalid screen layout";
                    break;
                default:
                    msg = "Unknown reason";
                    break;
                }
                Util.Info("Server did not accept the resize request: " + msg);
                return true;
            }

            this._encHandlers.handle_FB_resize();
            return true;
        },

        DesktopSize: function () {
            this._encHandlers.handle_FB_resize();
            return true;
        },

        Cursor: function () {
            Util.Debug(">> set_cursor");
            var x = this._FBU.x;  // hotspot-x
            var y = this._FBU.y;  // hotspot-y
            var w = this._FBU.width;
            var h = this._FBU.height;

            var pixelslength = w * h * this._pixelFormat.Bpp;
            var masklength = Math.floor((w + 7) / 8) * h;

            this._FBU.bytes = pixelslength + masklength;
            if (this._sock.rQwait("cursor encoding", this._FBU.bytes)) { return false; }

            this._display.changeCursor(this._sock.rQshiftBytes(pixelslength),
                                       this._sock.rQshiftBytes(masklength),
                                       x, y, w, h);

            this._FBU.bytes = 0;
            this._FBU.rects--;

            Util.Debug("<< set_cursor");
            return true;
        },

        JPEG_quality_lo: function () {
            Util.Error("Server sent jpeg_quality pseudo-encoding");
        },

        compress_lo: function () {
            Util.Error("Server sent compress level pseudo-encoding");
        },

        ATEN_HERMON: function () {
            if (this._FBU.aten_len === -1) {
                this._FBU.bytes = 8;
                if (this._sock.rQwait("ATEN_HERMON", this._FBU.bytes)) { return false; }
                this._FBU.bytes = 0;
                this._sock.rQskipBytes(4); // @KK: This is the "mysteryFlag".
                this._FBU.aten_len = this._sock.rQshift32();

                if (this._FBU.width === 64896 && this._FBU.height === 65056) {
                    Util.Info("ATEN iKVM screen is probably off");
                    if (this._FBU.aten_len !== 10 && this._FBU.aten_len !== 0) {
                        Util.Debug(">> ATEN iKVM screen off (aten_len="+this._FBU.aten_len+")");
                        this._fail('expected aten_len to be 10 when screen is off');
                    }
                    this._FBU.aten_len = 0;
                    return true;
                }
                if (this._fb_width !== this._FBU.width && this._fb_height !== this._FBU.height) {
                    Util.Debug(">> ATEN_HERMON resize desktop");
                    this._fb_width = this._FBU.width;
                    this._fb_height = this._FBU.height;
                    this._onFBResize(this, this._fb_width, this._fb_height);
                    this._display.resize(this._fb_width, this._fb_height);
                    Util.Debug("<< ATEN_HERMON resize desktop");
                }
            }

            if (this._FBU.aten_type === -1) {
                this._FBU.bytes = 10;
                if (this._sock.rQwait("ATEN_HERMON", this._FBU.bytes)) { return false; }
                this._FBU.bytes = 0;
                this._FBU.aten_type = this._sock.rQshift8();
                this._sock.rQskip8();

                this._sock.rQskipBytes(4); // number of subrects
                if (this._FBU.aten_len !== this._sock.rQshift32()) {
                    return this._fail('ATEN_HERMON RAW len mis-match');
                }
                this._FBU.aten_len -= 10;
            }

            while (this._FBU.aten_len > 0) {
                switch (this._FBU.aten_type) {
                    case 0: // Subrects
                        this._FBU.bytes = 6 + (16 * 16 * this._pixelFormat.Bpp);  // at least a subrect
                        if (this._sock.rQwait("ATEN_HERMON", this._FBU.bytes)) { return false; }
                        var a = this._sock.rQshift16();
                        var b = this._sock.rQshift16();
                        var y = this._sock.rQshift8();
                        var x = this._sock.rQshift8();
                        this._convert_color(this._destBuff, this._sock.rQshiftBytes(this._FBU.bytes - 6));
                        this._display.blitImage(x * 16, y * 16, 16, 16, this._destBuff, 0, true, false);
                        this._FBU.aten_len -= this._FBU.bytes;
                        this._FBU.bytes = 0;
                        break;
                    case 1: // RAW
                        var olines = (this._FBU.lines === 0) ? this._FBU.height : this._FBU.lines;
                        this._encHandlers.RAW();
                        this._FBU.aten_len -= (olines - this._FBU.lines) * this._FBU.width * this._pixelFormat.Bpp;
                        if (this._FBU.bytes > 0) return false;
                        break;
                    default:
                        return this._fail('unknown ATEN_HERMON type: '+this._FBU.aten_type);
                }
            }

            if (this._FBU.aten_len < 0) {
                this._fail('aten_len dropped below zero');
            }

            if (this._FBU.aten_type === 0) {
                this._FBU.rects--;
            }

            this._FBU.aten_len = -1;
            this._FBU.aten_type = -1;

            return true;
        },

        ATEN_AST2100: function () {
           
            if (this._FBU.aten_len === -1) {
                this._FBU.bytes = 8;
                if (this._sock.rQwait("ATEN_AST2100", this._FBU.bytes)) { return false; }

                // @KK: I think that the mysteryFlag is 0 when in "text mode" (at the BIOS, without X started, etc.) and
                // 1 when running X.  Perhaps it's something to do with what mode the "video card" is being used in?
                var mysteryFlag = this._sock.rQshift32();
                // if (mysteryFlag != 0)
                //     console.log('Nonzero mysteryFlag (='+mysteryFlag+')!  When does this occur?');
                this._FBU.aten_len = this._sock.rQshift32();
            }

            // Actually read the data.
            if (this._FBU.aten_len !== 0) {
                this._FBU.bytes = this._FBU.aten_len;
                if (this._sock.rQwait("ATEN_AST2100", this._FBU.bytes)) { return false; }
                var data = this._sock.rQshiftBytes(this._FBU.aten_len);
            }
            
            // Without this, the code in _framebufferUpdate() will keep looping instead of realizing that it's finished
            // and sending out a FramebufferUpdateRequest.  It's important to make sure this code is called as soon as
            // we have read any data we are going to read: in particular, it must be called BEFORE we might return true
            // ("we're done").  Otherwise... infinite loop!
            this._FBU.rects -= 1;
            if (this._FBU.rects != 0)
                throw 'Unexpected number of rects in FramebufferUpdate message; should always be 1!';
            
            // @KK: N.B.: It's also very important for the way that this function works that aten_len wind up -1 before
            // we ever return true; otherwise we'll fail to parse the two extra, ATEN-specific header fields (see above)
            // the next time we get a FramebufferUpdate message.
            this._FBU.aten_len = -1;
            
            if (this._FBU.width === 64896 && this._FBU.height === 65056) {  // I expect that these are -640 and -480 (as int16s), as in the other ATEN encodings.
                Util.Debug('Ast2100Decoder: screen is off.');
                if (this._FBU.aten_len !== 0)
                    Util.Warn('Ast2100Decoder: warning: framebuffer dimensions indicate that screen is off but data length is nonzero.');
                return true;
            } else if (this._FBU.aten_len === 0) {
                // This seems to happen when the display is off (e.g. when you tell the machine to restart).
                // TODO: Is there a way to tell noVNC that the display is "off"?  Should we show a black screen, or otherwise indicate to the user that this is what is going on?
                Util.Warn('Ast2100Decoder: warning: data length is zero, but framebuffer dimensions are not -640x-480 (which is typically given to indicate that the screen is off).');
                return true;
            }

            if (!this._aten_ast2100_dec) {
                var _rfb = this;
                var display = this._display;
                this._aten_ast2100_dec = new Ast2100Decoder({
                    width: this._FBU.width,
                    height: this._FBU.height,
                    blitCallback: function (x, y, width, height, buf) {
                        // Last arguments here are offset, from_queue.  'from_queue' means 'should this block be
                        // rendered from the queue?', not 'is this block being rendered from the queue?'.  It causes the
                        // block to be enqueued instead of being blitted right away via a call to _rgbxImageData().
                        display.blitRgbxImage(x, y, width, height, buf, 0, true);

                        // Last argument is offset.
                        // display._rgbxImageData(x, y, display._viewportLoc.x, display._viewportLoc.y, width, height, buf, 0);
                    },
                    videoSettingsChangedCallback: function (settings) {
                        _rfb._ast2100_onVideoSettingsChanged(settings);
                    }
                });
            }
            
            // @KK: Copied this block from ATEN_HERMON above.
            if (this._fb_width !== this._FBU.width && this._fb_height !== this._FBU.height) {
                Util.Debug(">> ATEN_AST2100 resize desktop");
                this._fb_width = this._FBU.width;
                this._fb_height = this._FBU.height;
                this._onFBResize(this, this._fb_width, this._fb_height);
                this._display.resize(this._fb_width, this._fb_height);
                Util.Debug("<< ATEN_AST2100 resize desktop");
                
                this._aten_ast2100_dec.setSize(this._FBU.width, this._FBU.height);
            }

            // // This can be useful for dumping data for testing purposes.
            // console.log(hexlify_u8a(data));
            // throw 'oops';

            this._aten_ast2100_dec.decode(data);
            return true;
        }
    };
})();
