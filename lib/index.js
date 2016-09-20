// @flow
import EventEmitter from 'events';
import arrayUniq from 'array-uniq';
import arrayDiffer from 'array-differ';
import * as util from './util';

export type Options = {
	delay?: number;
	timeout?: number;
	crop?: boolean;
	css?: string;
	cookies?: Array<string> | Object; // TODO how can I use `[cookies: string]: string` here instead of `Object`?
	filename?: string;
	selector?: string;
	hide?: Array<string>;
	username?: string;
	password?: string;
	scale?: number;
	format?: string;
	userAgent?: string;
	[headers: string]: string; // TODO: is this valid? Couldn't use `?` here.
};

type Src = {
	url: string;
	sizes: Array<string>;
	options: Options
};

export default class Pageres extends EventEmitter {
	/**
	 * Initialize a new Pageres
	 *
	 * @param {Object} options
	 * @api public
	 */

	options: Options;
	stats: Object;
	items: Array<stream$Readable>; // TODO: is `stream$Readable` correct?
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

	// src(url?: string, sizes?: Array<string>, options?: Options): Pageres | Array<Src> {
	src(url, sizes, options): Pageres | Array<Src> { // TODO: how can I make all the arguments optional or all required? the commented out line doesn't work as it complains it can also be `undefined`. Can I define a separate type definiton for each scenario?
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

	dest(dir): Pageres | string { // TODO: is there any way to define retur types based on input?
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

	async run(): Promise<stream$Readable[]> { // TODO: any way to define that it returns `this.items` and use its type?
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
}

Object.assign(Pageres.prototype, util);
