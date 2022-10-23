/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra and Zackary Jackson @ScriptedAlchemy
*/

"use strict";

const isValidExternalsType = require("../../schemas/plugins/container/ExternalsType.check.js");
const SharePlugin = require("../sharing/SharePlugin");
const createSchemaValidation = require("../util/create-schema-validation");
const ContainerPlugin = require("./ContainerPlugin");
const ContainerReferencePlugin = require("./ContainerReferencePlugin");

/** @typedef {import("../../declarations/plugins/container/ModuleFederationPlugin").ExternalsType} ExternalsType */
/** @typedef {import("../../declarations/plugins/container/ModuleFederationPlugin").ModuleFederationPluginOptions} ModuleFederationPluginOptions */
/** @typedef {import("../../declarations/plugins/container/ModuleFederationPlugin").Shared} Shared */
/** @typedef {import("../Compiler")} Compiler */

const validate = createSchemaValidation(
	require("../../schemas/plugins/container/ModuleFederationPlugin.check.js"),
	() => require("../../schemas/plugins/container/ModuleFederationPlugin.json"),
	{
		name: "Module Federation Plugin",
		baseDataPath: "options"
	}
);
class ModuleFederationPlugin {
	/**
	 * @param {ModuleFederationPluginOptions} options options
	 */
	constructor(options) {
		validate(options);

		this._options = options;
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		const { _options: options } = this;
		// expose 模块编译产物导出的类型，选项有 var、umd、commonjs、module 等，跟 output 配置中的 library 作用是一样的
		// var 代表输出的模块是挂在 window 对象上
		const library = options.library || { type: "var", name: options.name };
		// remote 模的类型，选项有 var、umd、commonjs、module 等，跟 output 配置中的 library 作用是一样的
		const remoteType =
			options.remoteType ||
			(options.library && isValidExternalsType(options.library.type)
				? /** @type {ExternalsType} */ (options.library.type)
				: "script");
		// 	enabledLibraryTypes 专门存储 entry 需要输出的 library 类型，然后被 EnableLibraryPlugin 插件消费，
		if (
			library &&
			!compiler.options.output.enabledLibraryTypes.includes(library.type)
		) {
			compiler.options.output.enabledLibraryTypes.push(library.type);
		}
		// 在完成所有内部插件注册后处理 MF 插件
		compiler.hooks.afterPlugins.tap("ModuleFederationPlugin", () => {
			if (
				options.exposes &&
				(Array.isArray(options.exposes)
					? options.exposes.length > 0
					: Object.keys(options.exposes).length > 0)
			) {
				// 如果有 expose 配置，则注册一个 ContainerPlugin
				new ContainerPlugin({
					name: options.name,
					library,
					filename: options.filename,
					runtime: options.runtime,
					shareScope: options.shareScope,
					exposes: options.exposes
				}).apply(compiler);
			}
			if (
				options.remotes &&
				(Array.isArray(options.remotes)
					? options.remotes.length > 0
					: Object.keys(options.remotes).length > 0)
			) {
				// 如果有 expose 配置，则初始化一个 ContainerReferencePlugin
				new ContainerReferencePlugin({
					remoteType,
					shareScope: options.shareScope,
					remotes: options.remotes
				}).apply(compiler);
			}
			if (options.shared) {
				// 如果有 expose 配置，则初始化一个 SharePlugin
				new SharePlugin({
					shared: options.shared,
					shareScope: options.shareScope
				}).apply(compiler);
			}
		});
	}
}

module.exports = ModuleFederationPlugin;
