Components.utils.import("resource://app/jsmodules/sbProperties.jsm");

if (typeof(songbird_GET_control) == "undefined") {
	var songbird_GET_control = {
		log: function(msg) {
			var consoleService = Components.classes["@mozilla.org/consoleservice;1"].getService(Components.interfaces.nsIConsoleService);
			consoleService.logStringMessage("songbirdServer: " + msg)
		},
	};
}

songbird_GET_control.controller = function(){
	var _core = null;
	var log = songbird_GET_control.log;
	var core = function() {
		if(_core == null) {
			_core = Cc["@songbirdnest.com/Songbird/Mediacore/Manager;1"].getService(Ci.sbIMediacoreManager);
		}
		return _core;
	};

	var ctl = {
		// this is where all the useful functions are defined.
		// core() returns the sbIMediacoreManager instance.
		play: function() {
			core().playbackControl.play();
		},

		status: function() {
			var c = core();
			var playing = c.status.state == 1;
			var mediaItem = c.sequencer.view.getItemByIndex(c.sequencer.viewPosition);
			var st = {
				playing: playing,
			};
			if(mediaItem) {
				st.artist = mediaItem.getProperty(SBProperties.artistName);
				st.album = mediaItem.getProperty(SBProperties.albumName);
				st.track = mediaItem.getProperty(SBProperties.trackName);
			}
			return st;
		},

		next: function() {
			core().sequencer.next();
		},

		prev: function() {
			core().sequencer.previous();
		},

		pause: function() {
			core().playbackControl.pause();
		},
		
		stop: function() {
			core().playbackControl.stop();
		},
		
		volumeup: function() {
			core().volumeControl.volume = core().volumeControl.volume +0.1;
		},
		
		volumedown: function() {
			core().volumeControl.volume = core().volumeControl.volume -0.1;
		},
		
		mute: function() {
			if (core().volumeControl.mute == true) {
				core().volumeControl.mute = false;
			}
			
			else {
				core().volumeControl.mute = true;
			}
		},

		playpause: function() {
			var c = core();
			//log("play status is: " + c.status.state);
			if(c.status.state == 1) { // playing
				c.playbackControl.pause();
			} else {
				c.playbackControl.play();
			}
		},
	};
	return ctl;
}();



// ----------------------------------------------
// server stuff (fairly boring, moderately hacky)

songbird_GET_control.server = (function(){
	var log = songbird_GET_control.log;
	var controller = songbird_GET_control.controller;
	var nativeJSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
	
	var server = {
		_id: Math.round(Math.random() * 1000),
		_socket: null,
		port: 50136,
		ver: "0.3",

		start: function() {
			server.port = Application.prefs.get("extensions.GET-control.port").value;
			log("port: " + server.port);
			if(server._socket) server.stop();

			server._listener._server = server;
			var loopbackOnly = Application.prefs.get("extensions.GET-control.localonly").value;
			server._socket = Components.classes["@mozilla.org/network/server-socket;1"].createInstance(Components.interfaces.nsIServerSocket);
			server._socket.init(server.port, loopbackOnly, -1);
			server._socket.asyncListen(server._listener);
			log("Server started successfully. Listening to port " + server.port + " " + (loopbackOnly ? "for localhost" : "for ALL hosts"));
		},

		stop: function() {
			if(server._socket) {
				log("Closing socket");
				server._socket.close();
			}
			server._socket = null;
		},


		/**
		* An object implementing nsIServerSocketListener
		*/
		_listener: {
			_httpGetRegExp: new RegExp("^(GET|POST|HEAD) [^ ]+ HTTP/\\d+.\\d+$"),

			onSocketAccepted: function(serverSocket, transport)
			{
				//log("onSocketAccepted");
				var istream = transport.openInputStream(transport.OPEN_BLOCKING, 0, 0);
				var ostream = transport.openOutputStream(transport.OPEN_BLOCKING, 0, 0);
				var sis = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(Components.interfaces.nsIScriptableInputStream);
				sis.init(istream);

				var request = "";
				var buffer = "";
				var n = 0; // so that we don't hang; XXX is there a better way?

				// read the request - everything before END_OF_HEADER. Any text after that
				// is considered junk and is not read.
				var CRLF = "\r\n", END_OF_HEADER = CRLF + CRLF;
				var lastThreeReadChars = "";
				var headerRead = false;
				while(transport.isAlive() && ++n < 10000 && !headerRead) {
					buffer = sis.read(-1);
					if(buffer.length == 0)
						continue;

					var extendedString = lastThreeReadChars + buffer;
					var sepIdx = extendedString.indexOf(END_OF_HEADER);
					if(sepIdx == -1) {
						request += buffer;
						lastThreeReadChars = extendedString.substr(-3, 3);
					} else {
						request += buffer.substr(0, sepIdx + END_OF_HEADER.length - lastThreeReadChars.length);
						headerRead = true;
					}
				}

				sis.close();

				// write |str| to ostream
				var write = function(str) {
					return ostream.write(str, str.length);
				}

				try { // todo: test various errors handling
					if(!headerRead) {
						log("timeout");
						log("read " + request.length + " bytes: " + request +
							"; headerRead=" + headerRead +
							"; isAlive=" + transport.isAlive() +
							"; n=" + n);
						write("HTTP/1.1 408 Request Time-out" + END_OF_HEADER);
					} else {
						response_obj = server.GET(request, ostream);
						if(response_obj == null) {
							response_obj = {};
						}
						response_obj.version = server.ver;
						var responseText = nativeJSON.encode(response_obj) + CRLF;
						var httpResponse = "HTTP/1.1 200 OK" + CRLF +
									"Content-Type: text/plain" + CRLF +
									"Content-Length: " + responseText.length + CRLF +
									CRLF +
									responseText;
						//log(httpResponse);
						write(httpResponse);
					}
				} finally {
					ostream.close();
				}
			},
		
			onStopListening: function(serverSocket, status) {
			}
		},


		GET: function(req, ostream) {
			//log("REQUEST: " + req);
			var match = req.match(/(\w+) \/ctl\/([^ ?]+)(\?[^ ]*)? /);
			var method = match[1];
			var command = match[2];
			var query = match[3];
			log("GOT ctl command: '" + command + "'");
			var ret = controller[command]();
			if(ret == null) {
				ret = controller.status();
			}
			return ret;
		},
	};
	return server;
})();


window.addEventListener("load", songbird_GET_control.server.start, false);
window.addEventListener("unload", songbird_GET_control.server.stop, false);

