/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra and Zackary Jackson @ScriptedAlchemy
*/

"use strict";

const ExternalsPlugin = require("../ExternalsPlugin");
const RuntimeGlobals = require("../RuntimeGlobals");
const createSchemaValidation = require("../util/create-schema-validation");
const FallbackDependency = require("./FallbackDependency");
const FallbackItemDependency = require("./FallbackItemDependency");
const FallbackModuleFactory = require("./FallbackModuleFactory");
const RemoteModule = require("./RemoteModule");
const RemoteRuntimeModule = require("./RemoteRuntimeModule");
const RemoteToExternalDependency = require("./RemoteToExternalDependency");
const { parseOptions } = require("./options");

/** @typedef {import("../../declarations/plugins/container/ContainerReferencePlugin").ContainerReferencePluginOptions} ContainerReferencePluginOptions */
/** @typedef {import("../../declarations/plugins/container/ContainerReferencePlugin").RemotesConfig} RemotesConfig */
/** @typedef {import("../Compiler")} Compiler */

const validate = createSchemaValidation(
	require("../../schemas/plugins/container/ContainerReferencePlugin.check.js"),
	() =>
		require("../../schemas/plugins/container/ContainerReferencePlugin.json"),
	{
		name: "Container Reference Plugin",
		baseDataPath: "options"
	}
);

const slashCode = "/".charCodeAt(0);

class ContainerReferencePlugin {
	/**
	 * @param {ContainerReferencePluginOptions} options options
	 */
	constructor(options) {
		validate(options);

		// 类型为 ExternalsType，指定 remote module 的类型，默认为 script
		this._remoteType = options.remoteType;
		// 处理 remote options 的时候，会将 remote 模块处理成 external 模块
		this._remotes = parseOptions(
			options.remotes,
			item => ({
				external: Array.isArray(item) ? item : [item],
				shareScope: options.shareScope || "default"
			}),
			item => ({
				external: Array.isArray(item.external)
					? item.external
					: [item.external],
				shareScope: item.shareScope || options.shareScope || "default"
			})
		);
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		const { _remotes: remotes, _remoteType: remoteType } = this;

		/** @type {Record<string, string>} */
		const remoteExternals = {};
		for (const [key, config] of remotes) {
			let i = 0;
			for (const external of config.external) {
				if (external.startsWith("internal ")) continue;
				remoteExternals[
					`webpack/container/reference/${key}${i ? `/fallback-${i}` : ""}`
				] = external;
				i++;
			}
		}

		// 注册 ExternalsPlugin
		// 在 webpack 中，external module 不会在当前的 compilation 中构建
		new ExternalsPlugin(remoteType, remoteExternals).apply(compiler);

		compiler.hooks.compilation.tap(
			"ContainerReferencePlugin",
			(compilation, { normalModuleFactory }) => {
				compilation.dependencyFactories.set(
					RemoteToExternalDependency,
					normalModuleFactory
				);

				compilation.dependencyFactories.set(
					FallbackItemDependency,
					normalModuleFactory
				);

				compilation.dependencyFactories.set(
					FallbackDependency,
					new FallbackModuleFactory()
				);

				// 在 module request resolved 之前调用，如果返回 undefined，则走正常规的 module factory 处理
				// mf 这里对于远程模块，返回一个 RemoteModule，则阻断了后续的 module factory
				normalModuleFactory.hooks.factorize.tap(
					"ContainerReferencePlugin",
					data => {
						// 在进行 module 处理的时候，如果发现有 module 是从 remote 导入的，例如 import routes from 'app1/routes'
						if (!data.request.includes("!")) {
							for (const [key, config] of remotes) {
								if (
									data.request.startsWith(`${key}`) &&
									(data.request.length === key.length ||
										data.request.charCodeAt(key.length) === slashCode)
								) {
									return new RemoteModule(
										data.request,
										config.external.map((external, i) =>
											external.startsWith("internal ")
												? external.slice(9)
												: `webpack/container/reference/${key}${
														i ? `/fallback-${i}` : ""
												  }`
										),
										`.${data.request.slice(key.length)}`,
										config.shareScope
									);
								}
							}
						}
					}
				);

				// runtimeRequirementInTree 是一个 HookMap，提供了一种集合操作 hook 的能力，降低使用的复杂度
				// 类型为 HookMap<SyncBailHook<[Chunk, Set<string>, RuntimeRequirementsContext]>>
				// 这里的 ensureChunkHandlers 是专门处理一个 module 运行时需要依赖的 webpack runtime
				compilation.hooks.runtimeRequirementInTree
					.for(RuntimeGlobals.ensureChunkHandlers)
					.tap("ContainerReferencePlugin", (chunk, set) => {
						// 这里添加的都是 webpack runtime 需要的各个方法
						set.add(RuntimeGlobals.module); // module
						set.add(RuntimeGlobals.moduleFactoriesAddOnly); // __webpack_require__.m (add only)
						set.add(RuntimeGlobals.hasOwnProperty); // __webpack_require__.o
						set.add(RuntimeGlobals.initializeSharing); // __webpack_require__.I
						set.add(RuntimeGlobals.shareScopeMap); // __webpack_require__.S
						// 将相关的 remote chunk 建立与 RemoteRuntimeModule 的关系
						compilation.addRuntimeModule(chunk, new RemoteRuntimeModule());
					});
			}
		);
	}
}

module.exports = ContainerReferencePlugin;
