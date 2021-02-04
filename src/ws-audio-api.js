//    WebSockets Audio API
//
//    Opus Quality Settings
//    =====================
//    App: 2048=voip, 2049=audio, 2051=low-delay
//    Sample Rate: 8000, 12000, 16000, 24000, or 48000
//    Frame Duration: 2.5, 5, 10, 20, 40, 60
//    Buffer Size = sample rate/6000 * 1024

(function (global) {
	var defaultConfig = {
		codec: {
			sampleRate: 24000,
			channels: 1,
			app: 2048,
			frameDuration: 20,
			bufferSize: 4096,
			calcBuffer: false
		},
		server: {
			host: window.location.hostname
		},
		contextOpts: {
			sampleRate: 24000
		}
	};

	var AudioContext = window.AudioContext || window.webkitAudioContext;
	var audioContext = false;

	var WSAudioAPI = global.WSAudioAPI = {
		Player: function (config, socket) {
			this.config = config || {};
			this.config.codec = this.config.codec || defaultConfig.codec;
			this.config.server = this.config.server || defaultConfig.server;
			this.config.contextOpts = this.config.contextOpts || defaultConfig.contextOpts;
			audioContext = new AudioContext(this.config.contextOpts);

			if (this.config.codec.calcBuffer) {
				this.config.codec.bufferSize = ((this.config.codec.sampleRate) / 6000) * 1024;
			}

			this.sampler = new Resampler(this.config.codec.sampleRate, audioContext.sampleRate, this.config.codec.channels, this.config.codec.bufferSize);
			this.parentSocket = socket;

			this.decoder = new OpusDecoder(this.config.codec.sampleRate, this.config.codec.channels);
			this.silence = new Float32Array(this.config.codec.bufferSize);
		},
		Streamer: function (config, socket) {
			navigator.getUserMedia = (navigator.getUserMedia ||
				navigator.webkitGetUserMedia ||
				navigator.mozGetUserMedia ||
				navigator.msGetUserMedia);

			this.config = config || {};
			this.config.codec = this.config.codec || defaultConfig.codec;
			this.config.server = this.config.server || defaultConfig.server;
			this.config.contextOpts = this.config.contextOpts || defaultConfig.contextOpts;
			audioContext = new AudioContext(this.config.contextOpts);
			this.sampler = new Resampler(audioContext.sampleRate, this.config.codec.sampleRate, this.config.codec.channels, this.config.codec.bufferSize);
			this.parentSocket = socket;
			this.encoder = new OpusEncoder(this.config.codec.sampleRate, this.config.codec.channels, this.config.codec.app, this.config.codec.frameDuration);
			var _this = this;

			this._makeStream = function (onError) {
				navigator.getUserMedia({ audio: true }, function (stream) {
					_this.stream = stream;
					_this.audioInput = audioContext.createMediaStreamSource(stream);
					_this.gainNode = audioContext.createGain();
					_this.recorder = audioContext.createScriptProcessor(_this.config.codec.bufferSize, this.config.codec.channels, this.config.codec.channels);

					_this.recorder.onaudioprocess = function (e) {
						var resampled = _this.sampler.resampler(e.inputBuffer.getChannelData(0));
						var packets = _this.encoder.encode_float(resampled);
						for (var i = 0; i < packets.length; i++) {
							if (_this.socket.readyState == 1) _this.socket.send(packets[i]);
						}
					};

					_this.audioInput.connect(_this.gainNode);
					_this.gainNode.connect(_this.recorder);
					_this.recorder.connect(audioContext.destination);
				}, onError || _this.onError);
			}
		}
	};

	WSAudioAPI.Streamer.prototype.start = function (onError) {
		var _this = this;

		if (!this.parentSocket) {
			this.socket = new WebSocket(this.config.server.host);
		} else {
			this.socket = this.parentSocket;
		}

		this.socket.binaryType = 'arraybuffer';

		if (this.socket.readyState == WebSocket.OPEN) {
			this._makeStream(onError);
		} else if (this.socket.readyState == WebSocket.CONNECTING) {
			var _onopen = this.socket.onopen;

			this.socket.onopen = function () {
				if (_onopen) {
					_onopen();
				}
				_this._makeStream(onError);
			}
		} else {
			console.error('Socket is in CLOSED state');
		}

		var _onclose = this.socket.onclose;

		this.socket.onclose = function (event) {
			if (_onclose) {
				_onclose(event);
			}
			if (_this.audioInput) {
				_this.audioInput.disconnect();
				_this.audioInput = null;
			}
			if (_this.gainNode) {
				_this.gainNode.disconnect();
				_this.gainNode = null;
			}
			if (_this.recorder) {
				_this.recorder.disconnect();
				_this.recorder = null;
			}
			_this.stream.getTracks()[0].stop();
			console.log('Disconnected from server', event.reason);
		};
	};

	WSAudioAPI.Streamer.prototype.mute = function () {
		this.gainNode.gain.value = 0;
		console.log('Mic muted');
	};

	WSAudioAPI.Streamer.prototype.unMute = function () {
		this.gainNode.gain.value = 1;
		console.log('Mic unmuted');
	};

	WSAudioAPI.Streamer.prototype.onError = function (e) {
		var error = new Error(e.name);
		error.name = 'NavigatorUserMediaError';
		throw error;
	};

	WSAudioAPI.Streamer.prototype.stop = function () {
		if (this.audioInput) {
			this.audioInput.disconnect();
			this.audioInput = null;
		}
		if (this.gainNode) {
			this.gainNode.disconnect();
			this.gainNode = null;
		}
		if (this.recorder) {
			this.recorder.disconnect();
			this.recorder = null;
		}
		this.stream.getTracks()[0].stop()

		if (!this.parentSocket) {
			this.socket.close();
		}
	};

	WSAudioAPI.Player.prototype.start = function () {
		var _this = this;

		this.audioQueue = {
			buffer: new Float32Array(0),

			write: function (newAudio) {
				var currentQLength = this.buffer.length;
				newAudio = _this.sampler.resampler(newAudio);
				var newBuffer = new Float32Array(currentQLength + newAudio.length);
				newBuffer.set(this.buffer, 0);
				newBuffer.set(newAudio, currentQLength);
				this.buffer = newBuffer;
			},

			read: function (nSamples) {
				var samplesToPlay = this.buffer.subarray(0, nSamples);
				this.buffer = this.buffer.subarray(nSamples, this.buffer.length);
				return samplesToPlay;
			},

			length: function () {
				return this.buffer.length;
			}
		};

		this.scriptNode = audioContext.createScriptProcessor(this.config.codec.bufferSize, this.config.codec.channels, this.config.codec.channels);
		this.scriptNode.onaudioprocess = function (e) {
			var chans = _this.config.codec.channels;
			if (_this.audioQueue.length()) {
				var buf = _this.audioQueue.read(_this.config.codec.bufferSize * chans);
				var channels = [];
				for (let c = 0; c < chans; c++) {
					channels.push(e.outputBuffer.getChannelData(c))
				}
				for (let i = 0; i < buf.length; i += chans) {
					for (let c = 0; c < channels.length; c++) {
						channels[c][i / 2] = buf[i + c];
					}
				}
			} else {
				for (let i = 0; i < chans; i++) {
					e.outputBuffer.getChannelData(i).set(_this.silence);
				}
			}
		};
		this.gainNode = audioContext.createGain();
		this.scriptNode.connect(this.gainNode);
		this.gainNode.connect(audioContext.destination);

		if (!this.parentSocket) {
			this.socket = new WebSocket(this.config.server);
		} else {
			this.socket = this.parentSocket;
		}
		var _onmessage = this.parentOnmessage = this.socket.onmessage;
		this.socket.onmessage = function (message) {
			if (_onmessage) {
				_onmessage(message);
			}
			if (message.data instanceof Blob) {
				var reader = new FileReader();
				reader.onload = function () {
					_this.audioQueue.write(_this.decoder.decode_float(reader.result));
				};
				reader.readAsArrayBuffer(message.data);
			}
		};
	};

	WSAudioAPI.Player.prototype.getVolume = function () {
		return this.gainNode ? this.gainNode.gain.value : 'Stream not started yet';
	};

	WSAudioAPI.Player.prototype.setVolume = function (value) {
		if (this.gainNode) this.gainNode.gain.value = value;
	};

	WSAudioAPI.Player.prototype.stop = function () {
		this.audioQueue = null;
		this.scriptNode.disconnect();
		this.scriptNode = null;
		this.gainNode.disconnect();
		this.gainNode = null;

		if (!this.parentSocket) {
			this.socket.close();
		} else {
			this.socket.onmessage = this.parentOnmessage;
		}
	};
})(window);
