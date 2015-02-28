define(["now", "uuid", "debounce", "emitter", "store", "worker"], function (now, uuid, debounce, Emitter, store, Worker) {
	var UPD_META_DELAY = 5 * 1000, // ms, как часто обновлять мата данные
		MASTER_DELAY = UPD_META_DELAY * 2, // ms, сколько времени считать мастер живым
		PEERS_DELAY = UPD_META_DELAY * 4, // ms, сколько времени считать peer живым
		QUEUE_WAIT = UPD_META_DELAY * 2, // ms, за какой период времени держать очередь событий

		_emitterEmit = Emitter.fn.emit
	;


	/**
	 * Проверка наличия элемента в массиве
	 * @param   {Array} array
	 * @param   {*}     value
	 * @returns {number}
	 * @private
	 */
	function _inArray(array, value) {
		var i = array.length;

		while (i--) {
			if (array[i] === value) {
				return i;
			}
		}

		return -1;
	}


	/**
	 * Выполнить команду
	 * @param {Hole}     hole
	 * @param {Object}   cmd
	 * @private
	 */
	function _execCmd(hole, cmd) {
		var fn = hole[cmd.name];
		var next = function (err, result) {
			cmd.error = err;
			cmd.result = result;
			cmd.response = true;

//			console.log('emit.res.cmd', cmd.name);
			hole.emit('CMD', cmd);
		};


		try {
			if (typeof fn === 'function') {
				if (fn.length === 2) {
					// Предпологается асинхронная работа
					fn(cmd.data, next);
				} else {
					next(null, fn(cmd.data));
				}
			} else {
				throw 'method not found';
			}
		} catch (err) {
			next('wormhole.' + cmd.name + ': ' + err.toString());
		}
	}



	/**
	 * @class   Hole
	 * @extends Emitter
	 * @desc    «Дырка» — общение между табами
	 * @param   {url}     url
	 * @param   {Boolean} [useStore]  использовать store
	 */
	function Hole(url, useStore) {
		var _this = this,
			_destroy = /* istanbul ignore next */ function () {
				if (window.addEventListener) {
					window.removeEventListener('unload', _destroy);
				} else {
					window.detachEvent('onunload', _destroy);
				}

				_this.destroy();
			};


		/**
		 * Идентификатор
		 * @type {String}
		 */
		_this.id = uuid();


		/**
		 * Объект хранилища
		 * @type {store}
		 */
		_this.store;


		/**
		 * Название группы
		 * @type {String}
		 */
		_this.url = (url || document.domain);


		/**
		 * @type {String}
		 * @private
		 */
		_this._storePrefix = uuid.hash(_this.url);


		/**
		 * Внутренний индекс для события
		 * @type {Number}
		 * @private
		 */
		_this._idx;


		/**
		 * Очередь событий
		 * @type {Object[]}
		 * @private
		 */
		_this._queue = [];


		/**
		 * Очередь команд
		 * @type {Array}
		 * @private
		 */
		_this._cmdQueue = [];


		/**
		 * Объект функций обратного вызова
		 * @type {Object}
		 * @private
		 */
		_this._callbacks = {};


		_this._processingCmdQueue = debounce(_this._processingCmdQueue, 30);


		// Подписываемя на получение команд
		_this.on('CMD', function (cmd) {
			var id = cmd.id,
				cmdQueue = _this._cmdQueue,
				callback = _this._callbacks[id],
				idx = cmdQueue.length;

			if (cmd.response) {
				if (!_this.master) {
					// Мастер обработал команду, удаляем её из очереди
					while (idx--) {
						if (cmdQueue[idx].id === id) {
							cmdQueue.splice(idx, 1);
							break;
						}
					}
				}

				if (callback) {
					// О, это результат для наc
					delete _this._callbacks[id];
					callback(cmd.error, cmd.result);
				}
			}
			else {
				// Добавляем в очередь
				cmdQueue.push(cmd);
				_this._processingCmdQueue();
			}
		});


		// Опачки!
		_this.on('master', function () {
			_this._processingCmdQueue();
		});


		// Получи сторадж
		_this._initStorage(function (store) {
			_this.store = store;

			try {
				/* istanbul ignore next */
				if (!useStore && Worker.support) {
					_this._initSharedWorkerTransport();
				} else {
					throw "NOT_SUPPORTED";
				}
			} catch (err) {
				_this._initStorageTransport();
			}
		});


		/* istanbul ignore next */
		if (window.addEventListener) {
			window.addEventListener('unload', _destroy);
		} else {
			window.attachEvent('onunload', _destroy);
		}
	}



	Hole.fn = Hole.prototype = /** @lends Hole.prototype */{
		_attempt: 0,

		/**
		 * Готовность «дырки»
		 * @type {Boolean}
		 */
		ready: false,

		/**
		 * Мастер-флаг
		 * @type {Boolean}
		 */
		master: false,

		/**
		 * Уничтожен?
		 * @type {Boolean}
		 */
		destroyed: false,

		/**
		 * Кол-во «дырок»
		 * @type {Number}
		 */
		length: 0,


		on: Emitter.fn.on,
		off: Emitter.fn.off,


		/**
		 * Вызвать удаленную команду на мастере
		 * @param {String}    cmd
		 * @param {*}         [data]
		 * @param {Function}  [callback]
		 */
		call: function (cmd, data, callback) {
			if (typeof data === 'function') {
				callback = data;
				data = void 0;
			}

			// Генерируем id команды
			var id = uuid();

			this._callbacks[id] = callback;

			this.emit('CMD', {
				id: id,
				name: cmd,
				data: data,
				source: this.id
			});
		},


		/**
		 * Испустить событие
		 * @param   {String} type
		 * @param   {*}      [args]
		 * @returns {Hole}
		 */
		emit: function (type, args) {
			this._queue.push({ ts: now(), type: type, args: args });
			return this;
		},


		/**
		 * Инициализиция хранилища
		 * @private
		 */
		_initStorage: function (callback) {
			var match = this.url.toLowerCase().match(/^(https?:)?\/\/([^/]+)/);

			if (match && match[2] !== document.domain) {
				return store.remote(this.url, callback);
			} else {
				callback(store);
				return store;
			}
		},


		/**
		 * Инициализация траспорта на основе SharedWorker
		 * @param  {Boolean}  [retry]  повтор
		 * @private
		 */
		_initSharedWorkerTransport: /* istanbul ignore next */ function (retry) {
			var _this = this,
				port,
				worker,
				url = _this.url,
				label = location.pathname + location.search,
				sharedUrl = _this._store('sharedUrl')
			;

			_this._attempt++;

//			console.log('try(' + _this._attempt + '):', label, retry, [sharedUrl, _this._prevUrl]);
			if (retry && (_this._prevUrl !== sharedUrl)) {
				retry = false;
			}
			_this._prevUrl = sharedUrl;

			try {
				sharedUrl = (retry || !sharedUrl) ? Worker.getSharedURL(url) : sharedUrl;

				_this.worker = (worker = Worker.create(sharedUrl));
				_this.port = (port = worker.port);

				_this._store('sharedUrl', sharedUrl);
//				console.log('new(' + _this._attempt + '):', label, [sharedUrl]);
			}
			catch (err) {
				if (_this._attempt > 3) {
					throw err;
				} else {
					_this._initSharedWorkerTransport(true);
				}
				return;
			}


			worker.addEventListener('error', function (err) {
//				console.log('error(' + _this._attempt + '):', label, [sharedUrl]);
				_this._initSharedWorkerTransport(true);
			}, false);


			_this.__onPortMessage = function (evt) { _this._onPortMessage(evt); };
			port.addEventListener('message', _this.__onPortMessage);
			port.start();
		},


		/**
		 * Сообщение от рабочего
		 * @param {Event} evt
		 * @private
		 */
		_onPortMessage: /* istanbul ignore next */ function (evt) {
			evt = evt.data;

			if (evt === 'CONNECTED') {
//				console.log(this.id, evt, this._store('sharedUrl'));

				this.emit = this._workerEmit;
				this.ready = true;
				this.port.postMessage({ hole: { id: this.id } });

				this._processingQueue();

				// Получили подтвреждение, что мы подсоединились
				_emitterEmit.call(this, 'ready', this);
			}
			else if (evt === 'PING') {
				// Ping? Pong!
				this.port.postMessage('PONG');
			}
			else if (evt === 'MASTER') {
				// Сказали, что мы теперь мастер
				this.master = true; // ОК
				_emitterEmit.call(this, 'master', this);
			}
			else if (evt.type === 'peers') {
				// Обновляем кол-во пиров
				this._updPeers(evt.data);
			}
			else {
//				console.log(this.id, evt.type);
				// Просто событие
				_emitterEmit.call(this, evt.type, evt.data);
			}
		},


		/**
		 * Инициализация транспорта на основе store
		 * @private
		 */
		_initStorageTransport: function () {
			var _this = this, _pidMeta;

			_this._idx = (_this._store('queue') || {}).idx || 0;


			// Реакция на обновление storage
			_this.__onStorage = function (key, data) {
				if (key.indexOf('peer.') > -1) {
					_this._updPeers();
				}
				else if (key === _this._storeKey('queue')) {
					_this._processingQueue(data[key].items);
				}
				else if (key === _this._storeKey('meta')) {
					_this._checkMetaDelayed();
				}
			};


			_this._checkMetaDelayed = function (upd) {
				 // Размазываем по времени проверку, а то много мастеров
				var ms = (window.performance ? performance.now() : now()).toString().substr(-2)|0;

				clearTimeout(_pidMeta);
				_pidMeta = setTimeout(function () {
					_this._checkMeta(upd);
				}, ms > 50 ? 100 - ms : ms);
			};

			_this.store.on('change', _this.__onStorage);

			// Разрыв для нормальной работы синхронной подписки на события (из вне)
			_this._pid = setTimeout(function () {
				_this.emit = _this._storeEmit;

				_this._pid = setInterval(function () {
					_this._checkMeta(true);
				}, UPD_META_DELAY);

				_this.ready = true;

				_emitterEmit.call(_this, 'ready', _this);

				_this._checkMetaDelayed(true);
				_this._processingQueue();
				_this._updPeers();
			}, 0);
		},



		/**
		 * Проверка мета данных
		 * @param  {boolean}  [upd]
		 * @private
		 */
		_checkMeta: function (upd) {
			var ts = now(),
				meta = this._store('meta') || { id: 0, ts: 0 },
				id = this.id,
				emitMasterEvent = false
			;


			// Проверяем master: быть или не быть
			/* istanbul ignore else */
			if ((!meta.id || (ts - meta.ts) > MASTER_DELAY) || (meta.id == id && !this.master)) {
				//console.log('check.master: ' + id + ' === ' + meta.id + '? delta: ' + (ts - meta.ts), this.master);

				upd = true;
				meta.id = id;
				emitMasterEvent = true;
				this.master = true;
			}

			if (upd) {
				if (this.master) {
					//console.log('master.upd: ' + this.id + ', delta: ' + (ts - meta.ts));

					meta.ts = ts;
					this._store('meta', meta);
					emitMasterEvent && _emitterEmit.call(this, 'master', this);
				}

				this._store('peer.' + id, ts);
			}
		},


		/**
		 * Обновляем кол-во и список «дырок»
		 * @param  {string[]}  [peers]
		 * @private
		 */
		_updPeers: function (peers) {
			var i,
				id,
				ts = now(),
				_this = this,
				_peers = _this._peers || [],
				changed = false,
				storeKey = this._storeKey('peer.');

			if (!peers) {
				peers = [];

				// Находим все активные peer'ы
				this.store.each(function (value, key) {
					if (key.indexOf(storeKey) > -1) {
						if ((ts - value) < PEERS_DELAY) {
							peers.push(key.substr(storeKey.length));
						}
						else if (_this.master) {
							_this.store.remove(key);
						}
					}
				});
			}

			i = Math.max(peers.length, _peers.length);
			while (i--) {
				id = peers[i];

				if (id && _inArray(_peers, id) === -1) {
					changed = true;
					_emitterEmit.call(this, 'peers:add', id);
				}

				if (_peers[i] != id) {
					id = _peers[i];

					if (id && _inArray(peers, id) === -1) {
						changed = true;
						_emitterEmit.call(this, 'peers:remove', id);
					}
				}
			}

			if (changed) {
				this._peers = peers;
				this.length = peers.length;
				_emitterEmit.call(this, 'peers', [peers]);
			}
		},


		/**
		 * Получить ключь для store
		 * @param   {String}  key
		 * @returns {String}
		 * @private
		 */
		_storeKey: function (key) {
			return this._storePrefix + '.' + key;
		},


		/**
		 * Записать или получить информацию из хранилища
		 * @param   {String}  key
		 * @param   {*}       [value]
		 * @returns {Object}
		 * @private
		 */
		_store: function (key, value) {
			key = this._storeKey(key);

			if (value === null) {
				this.store.remove(key);
			}
			else if (value === void 0) {
				value = this.store.get(key);
			}
			else {
				this.store.set(key, value);
			}

			return value;
		},


		/**
		 * Emit через SharedWorker
		 * @param type
		 * @param args
		 * @private
		 */
		_workerEmit: /* istanbul ignore next */ function (type, args) {
			var ts = now();

			this.port.postMessage({
				ts: ts,
				type: type,
				data: args
			});

			return this;
		},


		/**
		 * Emit через хранилище
		 * @param type
		 * @param args
		 * @private
		 */
		_storeEmit: function (type, args) {
			var queue = this._store('queue') || { items: [], idx: 0 },
				ts = now(),
				items = queue.items,
				i = items.length
			;

			items.push({
				ts: ts,
				idx: ++queue.idx,
				type: type,
				args: args,
				source: this.id
			});

			while (i--) {
				if (ts - items[i].ts > QUEUE_WAIT) {
					items.splice(0, i);
					break;
				}
			}

			this._store('queue', queue);
			this._processingQueue(queue.items);

			return this;
		},


		/**
		 * Обработка очереди событий
		 * @param  {Object[]} [queue]
		 * @private
		 */
		_processingQueue: function (queue) {
			var evt;

			if (queue === void 0) {
				queue = this._queue;

				while (queue.length) {
					evt = queue.shift();
					this.emit(evt.type, evt.args);
				}
			}
			else {
				for (var i = 0, n = queue.length; i < n; i++) {
					evt = queue[i];

					if (this._idx < evt.idx) {
						this._idx = evt.idx;

//						if (evt.source !== this.id) {
							_emitterEmit.call(this, evt.type, evt.args);
//						}
					}
				}
			}
		},


		/**
		 * Обработка очереди команд
		 * @private
		 */
		_processingCmdQueue: function () {
			var cmdQueue = this._cmdQueue;

			/* istanbul ignore else */
			if (this.master) {
				while (cmdQueue.length) {
					_execCmd(this, cmdQueue.shift());
				}
			}
		},


		/**
		 * Уничтожить
		 */
		destroy: function () {
			if (!this.destroyed) {
				this.ready = false;
				this.destroyed = true;

				clearTimeout(this._pid);

				// Описываем все события
				this.off();
				store.off('change', this.__onStorage);

				/* istanbul ignore next */
				if (this.port) {
					this.port.removeEventListener('message', this.__onPortMessage);
					this.port.postMessage('DESTROY');
					this.port = null;
					this.worker = null;
				}
				else {
					this._store('peer.' + this.id, null);

					/* istanbul ignore else */
					if (this.master) {
						// Если я мастер, удаляем инфу об этом или назначаем последний открытий таб
						var meta = null,
							_peers = this._peers || [];

						// Удаляем себя
						_peers.splice(_inArray(_peers, this.id), 1);

						if (_peers.length > 0) {
							meta = { id: _peers.pop(), ts: now() - MASTER_DELAY/1.5 };
						}

						this._store('meta', meta);
//						console.log('master destroyed');
					}
				}

				this.master = false;
			}
		}
	};


	// Export
	return Hole;
});
