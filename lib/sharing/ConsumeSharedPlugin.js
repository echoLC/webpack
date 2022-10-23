/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const ModuleNotFoundError = require("../ModuleNotFoundError");
const RuntimeGlobals = require("../RuntimeGlobals");
const WebpackError = require("../WebpackError");
const { parseOptions } = require("../container/options");
const LazySet = require("../util/LazySet");
const createSchemaValidation = require("../util/create-schema-validation");
const { parseRange } = require("../util/semver");
const ConsumeSharedFallbackDependency = require("./ConsumeSharedFallbackDependency");
const ConsumeSharedModule = require("./ConsumeSharedModule");
const ConsumeSharedRuntimeModule = require("./ConsumeSharedRuntimeModule");
const ProvideForSharedDependency = require("./ProvideForSharedDependency");
const { resolveMatchedConfigs } = require("./resolveMatchedConfigs");
const {
	isRequiredVersion,
	getDescriptionFile,
	getRequiredVersionFromDescriptionFile
} = require("./utils");

/** @typedef {import("../../declarations/plugins/sharing/ConsumeSharedPlugin").ConsumeSharedPluginOptions} ConsumeSharedPluginOptions */
/** @typedef {import("../../declarations/plugins/sharing/ConsumeSharedPlugin").ConsumesConfig} ConsumesConfig */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../ResolverFactory").ResolveOptionsWithDependencyType} ResolveOptionsWithDependencyType */
/** @typedef {import("./ConsumeSharedModule").ConsumeOptions} ConsumeOptions */

const validate = createSchemaValidation(
	require("../../schemas/plugins/sharing/ConsumeSharedPlugin.check.js"),
	() => require("../../schemas/plugins/sharing/ConsumeSharedPlugin.json"),
	{
		name: "Consume Shared Plugin",
		baseDataPath: "options"
	}
);

/** @type {ResolveOptionsWithDependencyType} */
const RESOLVE_OPTIONS = { dependencyType: "esm" };
const PLUGIN_NAME = "ConsumeSharedPlugin";

class ConsumeSharedPlugin {
	/**
	 * @param {ConsumeSharedPluginOptions} options options
	 */
	constructor(options) {
		if (typeof options !== "string") {
			validate(options);
		}

		/** @type {[string, ConsumeOptions][]} */
		this._consumes = parseOptions(
			options.consumes,
			(item, key) => {
				if (Array.isArray(item)) throw new Error("Unexpected array in options");
				/** @type {ConsumeOptions} */
				let result =
					item === key || !isRequiredVersion(item)
						? // item is a request/key
						  {
								import: key,
								shareScope: options.shareScope || "default",
								shareKey: key,
								requiredVersion: undefined,
								packageName: undefined,
								strictVersion: false,
								singleton: false,
								eager: false
						  }
						: // key is a request/key
						  // item is a version
						  {
								import: key,
								shareScope: options.shareScope || "default",
								shareKey: key,
								requiredVersion: parseRange(item),
								strictVersion: true,
								packageName: undefined,
								singleton: false,
								eager: false
						  };
				return result;
			},
			(item, key) => ({
				import: item.import === false ? undefined : item.import || key,
				shareScope: item.shareScope || options.shareScope || "default",
				shareKey: item.shareKey || key,
				requiredVersion:
					typeof item.requiredVersion === "string"
						? parseRange(item.requiredVersion)
						: item.requiredVersion,
				strictVersion:
					typeof item.strictVersion === "boolean"
						? item.strictVersion
						: item.import !== false && !item.singleton,
				packageName: item.packageName,
				singleton: !!item.singleton,
				eager: !!item.eager
			})
		);
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.thisCompilation.tap(
			PLUGIN_NAME,
			(compilation, { normalModuleFactory }) => {
				compilation.dependencyFactories.set(
					ConsumeSharedFallbackDependency,
					normalModuleFactory
				);

				let unresolvedConsumes, resolvedConsumes, prefixedConsumes;
				// resolveMatchedConfigs 的作用是通过 resolver 按传入的配置去尝试加载模块
				// 每个 compiler 有一个 resolverFactory ，而 ResolverFactory 是基于 enhanced-resolve 封装专门加载模块路径的工厂方法
				// enhanced-resolve 封装了支持异步高可配置的 require.resolve
				// 根据不同的 module request 路径，获取异步收集到的 resolvedConsumes、unresolvedConsumes、prefixedConsumes 配置
				const promise = resolveMatchedConfigs(compilation, this._consumes).then(
					({ resolved, unresolved, prefixed }) => {
						resolvedConsumes = resolved;
						unresolvedConsumes = unresolved;
						prefixedConsumes = prefixed;
					}
				);

				// 获取一个 type 为 normal 类型的模块路径加载器
				const resolver = compilation.resolverFactory.get(
					"normal",
					RESOLVE_OPTIONS
				);

				/**
				 * @param {string} context issuer directory
				 * @param {string} request request
				 * @param {ConsumeOptions} config options
				 * @returns {Promise<ConsumeSharedModule>} create module
				 */
				// 创建一个 ConsumeSharedModule，但是在此之前会做两个事：
				// 1.判断模块是否能被 resolve 2.校验模块的版本
				const createConsumeSharedModule = (context, request, config) => {
					const requiredVersionWarning = details => {
						const error = new WebpackError(
							`No required version specified and unable to automatically determine one. ${details}`
						);
						error.file = `shared module ${request}`;
						compilation.warnings.push(error);
					};
					const directFallback =
						config.import &&
						/^(\.\.?(\/|$)|\/|[A-Za-z]:|\\\\)/.test(config.import);
					return Promise.all([
						new Promise(resolve => {
							if (!config.import) return resolve();
							const resolveContext = {
								/** @type {LazySet<string>} */
								fileDependencies: new LazySet(),
								/** @type {LazySet<string>} */
								contextDependencies: new LazySet(),
								/** @type {LazySet<string>} */
								missingDependencies: new LazySet()
							};
							// 判断模块是否可以 resolved
							resolver.resolve(
								{},
								directFallback ? compiler.context : context,
								config.import,
								resolveContext,
								(err, result) => {
									compilation.contextDependencies.addAll(
										resolveContext.contextDependencies
									);
									compilation.fileDependencies.addAll(
										resolveContext.fileDependencies
									);
									compilation.missingDependencies.addAll(
										resolveContext.missingDependencies
									);
									if (err) {
										compilation.errors.push(
											new ModuleNotFoundError(null, err, {
												name: `resolving fallback for shared module ${request}`
											})
										);
										return resolve();
									}
									resolve(result);
								}
							);
						}),
						// 根据 package.json 校验 shared 模块版本
						new Promise(resolve => {
							if (config.requiredVersion !== undefined)
								return resolve(config.requiredVersion);
							let packageName = config.packageName;
							if (packageName === undefined) {
								if (/^(\/|[A-Za-z]:|\\\\)/.test(request)) {
									// For relative or absolute requests we don't automatically use a packageName.
									// If wished one can specify one with the packageName option.
									return resolve();
								}
								const match = /^((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(request);
								if (!match) {
									requiredVersionWarning(
										"Unable to extract the package name from request."
									);
									return resolve();
								}
								packageName = match[0];
							}

							getDescriptionFile(
								compilation.inputFileSystem,
								context,
								["package.json"],
								(err, result) => {
									if (err) {
										requiredVersionWarning(
											`Unable to read description file: ${err}`
										);
										return resolve();
									}
									const { data, path: descriptionPath } = result;
									if (!data) {
										requiredVersionWarning(
											`Unable to find description file in ${context}.`
										);
										return resolve();
									}
									const requiredVersion = getRequiredVersionFromDescriptionFile(
										data,
										packageName
									);
									if (typeof requiredVersion !== "string") {
										requiredVersionWarning(
											`Unable to find required version for "${packageName}" in description file (${descriptionPath}). It need to be in dependencies, devDependencies or peerDependencies.`
										);
										return resolve();
									}
									resolve(parseRange(requiredVersion));
								}
							);
						})
					]).then(([importResolved, requiredVersion]) => {
						// 都成功后再创建 ConsumeSharedModule 模块
						return new ConsumeSharedModule(
							directFallback ? compiler.context : context,
							{
								...config,
								importResolved,
								import: importResolved ? config.import : undefined,
								requiredVersion
							}
						);
					});
				};

				// 因为创建一个 ConsumeSharedModule 是异步的，所以这里需要用 tapPromise
				normalModuleFactory.hooks.factorize.tapPromise(
					PLUGIN_NAME,
					({ context, request, dependencies }) =>
						// wait for resolving to be complete
						promise.then(() => {
							if (
								dependencies[0] instanceof ConsumeSharedFallbackDependency ||
								dependencies[0] instanceof ProvideForSharedDependency
							) {
								return;
							}
							const match = unresolvedConsumes.get(request);
							// 一般的 { react: { eager: true, singleton: true } } 配置走的是这个创建逻辑
							if (match !== undefined) {
								return createConsumeSharedModule(context, request, match);
							}
							// { shared: {'./utils/shared': './utils/shared' } 配置走的是这个创建逻辑
							for (const [prefix, options] of prefixedConsumes) {
								if (request.startsWith(prefix)) {
									const remainder = request.slice(prefix.length);
									return createConsumeSharedModule(context, request, {
										...options,
										import: options.import
											? options.import + remainder
											: undefined,
										shareKey: options.shareKey + remainder
									});
								}
							}
						})
				);
				normalModuleFactory.hooks.createModule.tapPromise(
					PLUGIN_NAME,
					({ resource }, { context, dependencies }) => {
						if (
							dependencies[0] instanceof ConsumeSharedFallbackDependency ||
							dependencies[0] instanceof ProvideForSharedDependency
						) {
							return Promise.resolve();
						}
						// 如果有一个内部模块声明成 shared，则会在 createModule 钩子创建一个 ConsumeSharedModule
						// 这个钩子在创建一个 NormalModule 之前触发
						const options = resolvedConsumes.get(resource);
						if (options !== undefined) {
							return createConsumeSharedModule(context, resource, options);
						}
						return Promise.resolve();
					}
				);
				compilation.hooks.additionalTreeRuntimeRequirements.tap(
					PLUGIN_NAME,
					(chunk, set) => {
						// 这里跟 ContainerReferencePlugin 差不多，为相关的 chunk 添加 webpack runtime 依赖的函数
						set.add(RuntimeGlobals.module); // module，内部模块对象
						set.add(RuntimeGlobals.moduleCache); // __webpack_require__.c 模块缓存对象
						set.add(RuntimeGlobals.moduleFactoriesAddOnly); // __webpack_require__.m (add only)
						set.add(RuntimeGlobals.shareScopeMap); // __webpack_require__.S
						set.add(RuntimeGlobals.initializeSharing); // __webpack_require__.I
						set.add(RuntimeGlobals.hasOwnProperty); // __webpack_require__.o
						// 将相关的 shared chunk 建立与 ConsumeSharedRuntimeModule 的关系
						compilation.addRuntimeModule(
							chunk,
							new ConsumeSharedRuntimeModule(set)
						);
					}
				);
			}
		);
	}
}

module.exports = ConsumeSharedPlugin;
