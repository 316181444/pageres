// @flow
import path from 'path';
import EventEmitter from 'events';
import {Readable} from 'stream';
import arrayUniq from 'array-uniq';
import arrayDiffer from 'array-differ';
import easydate from 'easydate';
import fsWriteStreamAtomic from 'fs-write-stream-atomic';
import getRes from 'get-res';
import logSymbols from 'log-symbols';
import mem from 'mem';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import screenshotStream from 'screenshot-stream';
import viewportList from 'viewport-list';
import protocolify from 'protocolify';
import filenamifyUrl from 'filenamify-url';
import template from 'lodash.template';
import pify from 'pify';
import plur from 'plur';

// TODO: make some of the methods not depend on `this` and move them out again
// TODO: remove JSDoc comments
// TODo: simplify the API. This will make Flow easier to use too

type PageresStream = Readable & {filename: string};

type Options = {
	delay?: number;
	timeout?: number;
	crop?: boolean;
	css?: string;
	cookies?: Array<string> | {[key: string]: string};
	filename?: string;
	selector?: string;
	hide?: Array<string>;
	username?: string;
	password?: string;
	scale?: number;
	format?: string;
	userAgent?: string;
	headers?: {[header: string]: string};
};

type Src = {
	url: string;
	sizes: Array<string>;
	options: Options;
};

type Viewport = {
	url: string;
	sizes: Array<string>;
	keywords: Array<string>;
};

type srcFn<Value> =
	& ((_: void) => void) // TODO: should return `this._src`
	& ((url: string, sizes: Array<string>, options?: Options) => Value); // TODO: should return `this`

type destFn<Value> =
	& ((_: void) => void) // TODO: should return `this._dest`
	& ((dir: string) => Value); // TODO: should return `this`

const getResMem = mem(getRes);
const viewportListMem = mem(viewportList);

let listener;

export default class Pageres<Value> extends EventEmitter {
	/**
	 * Initialize a new Pageres
	 *
	 * @param {Object} options
	 * @api public
	 */
	options: Options;
	stats: Object;
	items: Array<PageresStream>;
	sizes: Array<string>;
	urls: Array<string>;
	_src: Array<Src>;
	_dest: string;

	constructor(options: Options) {
		super();

		this.options = Object.assign({}, options);
		this.options.filename = this.options.filename || '<%= url %>-<%= size %><%= crop %>';
		this.options.format = this.options.format || 'png';

		this.stats = {};
		this.items = [];
		this.sizes = [];
		this.urls = [];
		this._src = [];
	}

	/**
	 * Get or set page to capture
	 *
	 * @param {String} url
	 * @param {Array} sizes
	 * @param {Object} options
	 * @api public
	 */
	src: srcFn<Value>;
	src(url, sizes, options) { // TODO: how can I make all the arguments optional or all required? the commented out line doesn't work as it complains it can also be `undefined`. Can I define a separate type definiton for each scenario?
		if (!arguments.length) {
			return this._src;
		}

		this._src.push({url, sizes, options});

		return this;
	}

	/**
	 * Get or set the destination directory
	 *
	 * @param {String} dir
	 * @api public
	 */
	dest: destFn<Value>;
	dest(dir) {
		if (!arguments.length) {
			return this._dest;
		}

		this._dest = dir;

		return this;
	}

	/**
	 * Run pageres
	 *
	 * @api public
	 */
	async run(): Promise<PageresStream[]> { // TODO: any way to define that it returns `this.items` and use its type?
		await Promise.all(this.src().map(src => {
			const options = Object.assign({}, this.options, src.options);
			const sizes = arrayUniq(src.sizes.filter(/./.test, /^\d{2,4}x\d{2,4}$/i));
			const keywords = arrayDiffer(src.sizes, sizes);

			if (!src.url) {
				throw new Error('URL required');
			}

			this.urls.push(src.url);

			if (!sizes.length && keywords.indexOf('w3counter') !== -1) {
				return this.resolution(src.url, options);
			}

			if (keywords.length) {
				return this.viewport({url: src.url, sizes, keywords}, options);
			}

			for (const size of sizes) {
				this.sizes.push(size);
				this.items.push(this.create(src.url, size, options));
			}
		}));

		this.stats.urls = arrayUniq(this.urls).length;
		this.stats.sizes = arrayUniq(this.sizes).length;
		this.stats.screenshots = this.items.length;

		if (!this.dest()) {
			return this.items;
		}

		await this.save(this.items);

		return this.items;
	}

	/**
	 * Fetch ten most popular resolutions
	 *
	 * @param {String} url
	 * @param {Object} options
	 * @api private
	 */
	async resolution(url: string, options: Options) {
		for (const item of await getResMem()) {
			this.sizes.push(item.item);
			this.items.push(this.create(url, item.item, options));
		}
	}

	/**
	 * Fetch keywords
	 *
	 * @param {Object} obj
	 * @param {Object} options
	 */
	async viewport(obj: Viewport, options: Options) {
		for (const item of await viewportListMem(obj.keywords)) {
			this.sizes.push(item.size);
			obj.sizes.push(item.size);
		}

		for (const size of arrayUniq(obj.sizes)) {
			this.items.push(this.create(obj.url, size, options));
		}
	}

	/**
	 * Save an array of streams to files
	 *
	 * @param {Array} streams
	 * @api private
	 */
	async save(streams: Array<PageresStream>) {
		const files = [];

		async function end() {
			return await Promise.all(files.map(file => pify(rimraf)(file)));
		}

		if (!listener) {
			listener = process.on('SIGINT', async () => {
				await end();
				process.exit(1); // eslint-disable-line xo/no-process-exit
			});
		}

		return await Promise.all(streams.map(stream =>
			new Promise(async (resolve, reject) => {
				await pify(mkdirp)(this.dest());

				const dest = path.join(this.dest(), stream.filename);
				const write = fsWriteStreamAtomic(dest);

				files.push(write.__atomicTmp);

				stream.on('warn', this.emit.bind(this, 'warn'));
				stream.on('error', err => end().then(reject(err)));

				write.on('finish', resolve);
				write.on('error', err => end().then(reject(err)));

				stream.pipe(write);
			})
		));
	}

	/**
	 * Create a pageres stream
	 *
	 * @param {String} uri
	 * @param {String} size
	 * @param {Object} options
	 * @api private
	 */
	create(uri: string, size: string, options: Options) { // TODO: Note to self, why do we pass the options around?
		const sizes = size.split('x');
		const stream = screenshotStream(protocolify(uri), size, options);
		const filename = template(`${options.filename}.${options.format}`);

		if (path.isAbsolute(uri)) {
			uri = path.basename(uri);
		}

		stream.filename = filename({
			crop: options.crop ? '-cropped' : '',
			date: easydate('Y-M-d'),
			time: easydate('h-m-s'),
			size,
			width: sizes[0],
			height: sizes[1],
			url: filenamifyUrl(uri)
		});

		return stream;
	}

	/**
	 * Success message
	 *
	 * @api private
	 */
	successMessage() {
		const stats = this.stats;
		const {screenshots, sizes, urls} = stats;
		const words = {
			screenshots: plur('screenshot', screenshots),
			sizes: plur('size', sizes),
			urls: plur('url', urls)
		};

		console.log(`\n${logSymbols.success} Generated ${screenshots} ${words.screenshots} from ${urls} ${words.urls} and ${sizes} ${words.sizes}`);
	}
}
