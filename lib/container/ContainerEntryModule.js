/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra, Zackary Jackson @ScriptedAlchemy, Marais Rossouw @maraisr
*/

"use strict";

const { OriginalSource, RawSource } = require("webpack-sources");
const AsyncDependenciesBlock = require("../AsyncDependenciesBlock");
const Module = require("../Module");
const RuntimeGlobals = require("../RuntimeGlobals");
const Template = require("../Template");
const StaticExportsDependency = require("../dependencies/StaticExportsDependency");
const makeSerializable = require("../util/makeSerializable");
const ContainerExposedDependency = require("./ContainerExposedDependency");

/** @typedef {import("../../declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptions */
/** @typedef {import("../ChunkGraph")} ChunkGraph */
/** @typedef {import("../ChunkGroup")} ChunkGroup */
/** @typedef {import("../Compilation")} Compilation */
/** @typedef {import("../Module").CodeGenerationContext} CodeGenerationContext */
/** @typedef {import("../Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("../Module").LibIdentOptions} LibIdentOptions */
/** @typedef {import("../Module").NeedBuildContext} NeedBuildContext */
/** @typedef {import("../RequestShortener")} RequestShortener */
/** @typedef {import("../ResolverFactory").ResolverWithOptions} ResolverWithOptions */
/** @typedef {import("../WebpackError")} WebpackError */
/** @typedef {import("../util/Hash")} Hash */
/** @typedef {import("../util/fs").InputFileSystem} InputFileSystem */
/** @typedef {import("./ContainerEntryDependency")} ContainerEntryDependency */

/**
 * @typedef {Object} ExposeOptions
 * @property {string[]} import requests to exposed modules (last one is exported)
 * @property {string} name custom chunk name for the exposed module
 */

const SOURCE_TYPES = new Set(["javascript"]);

class ContainerEntryModule extends Module {
	/**
	 * @param {string} name container entry name
	 * @param {[string, ExposeOptions][]} exposes list of exposed modules
	 * @param {string} shareScope name of the share scope
	 */
	constructor(name, exposes, shareScope) {
		// 这里的 javascript/dynamic 代表模块类型
		super("javascript/dynamic", null);
		this._name = name;
		this._exposes = exposes;
		this._shareScope = shareScope;
	}

	/**
	 * @returns {Set<string>} types available (do not mutate)
	 */
	getSourceTypes() {
		return SOURCE_TYPES;
	}

	/**
	 * @returns {string} a unique identifier of the module
	 */
	identifier() {
		return `container entry (${this._shareScope}) ${JSON.stringify(
			this._exposes
		)}`;
	}

	/**
	 * @param {RequestShortener} requestShortener the request shortener
	 * @returns {string} a user readable identifier of the module
	 */
	readableIdentifier(requestShortener) {
		return `container entry`;
	}

	/**
	 * @param {LibIdentOptions} options options
	 * @returns {string | null} an identifier for library inclusion
	 */
	libIdent(options) {
		return `${this.layer ? `(${this.layer})/` : ""}webpack/container/entry/${
			this._name
		}`;
	}

	/**
	 * @param {NeedBuildContext} context context info
	 * @param {function((WebpackError | null)=, boolean=): void} callback callback function, returns true, if the module needs a rebuild
	 * @returns {void}
	 */
	needBuild(context, callback) {
		return callback(null, !this.buildMeta);
	}

	/**
	 * @param {WebpackOptions} options webpack options
	 * @param {Compilation} compilation the compilation
	 * @param {ResolverWithOptions} resolver the resolver
	 * @param {InputFileSystem} fs the file system
	 * @param {function(WebpackError=): void} callback callback function
	 * @returns {void}
	 */
	build(options, compilation, resolver, fs, callback) {
		this.buildMeta = {};
		this.buildInfo = {
			strict: true,
			topLevelDeclarations: new Set(["moduleMap", "get", "init"])
		};
		this.buildMeta.exportsType = "namespace";

		this.clearDependenciesAndBlocks();

		// 这里就是根据 exposes 的配置创建 module 的依赖关系的过程，这里的 block 其实就是 module，对于 MF exposes 配置来说都是异步的 module
		// 这里的 name 就是 exposes 配置中的 key，options 就是处理之后的 value，例如 exposes: { './share', './src/shared.ts' }，name 就是 ./share
		for (const [name, options] of this._exposes) {
			// Entry、Dependency 、DependenciesBlock、Module 之间的关系是什么
			/* 
				Entry 就是 webpack 的入口配置，我们知道 webpack 构建过程就是从 entry 出发构建依赖图谱，构建结束后将所有的依赖组合起来，
				输出多个 bundle 对于 MF，expose 配置就是 entry
				
				Dependency 就是一个模块依赖的另一个文件模块的抽象，每个 module 都有一个 dependencies 数组，而一般的 module 通常都是继承自 DependenciesBlock
				所以，可以简单理解 DependenciesBlock = Module
				在 MF 中，所有的 module 都是 AsyncDependenciesBlock，因为 expose 出去的模块都是异步模块， 在运行时动态加载
			 */
			const block = new AsyncDependenciesBlock(
				{
					name: options.name
				},
				{ name },
				options.import[options.import.length - 1]
			);
			let idx = 0;
			// 构建 block 依赖的 deps
			for (const request of options.import) {
				const dep = new ContainerExposedDependency(name, request);
				dep.loc = {
					name,
					index: idx++
				};

				block.addDependency(dep);
			}
			// 建立 block 和 block 之间的父子关系
			this.addBlock(block);
		}
		// reference https://webpack.js.org/configuration/optimization/#optimizationprovidedexports
		// 添加这个 dep 是为了告诉 webpack 一个模块导出了哪些方法，能让 webpack 构建的时候为 export * from xxx 生成执行效率更高的代码
		this.addDependency(new StaticExportsDependency(["get", "init"], false));

		callback();
	}

	/**
	 * @param {CodeGenerationContext} context context for code generation
	 * @returns {CodeGenerationResult} result
	 */
	codeGeneration({ moduleGraph, chunkGraph, runtimeTemplate }) {
		const sources = new Map();
		const runtimeRequirements = new Set([
			RuntimeGlobals.definePropertyGetters,
			RuntimeGlobals.hasOwnProperty,
			RuntimeGlobals.exports
		]);
		const getters = [];

		// 这里是取出 module 依赖的 blocks，然后取出 dependencies，然后生成模块的 runtime 时的依赖数组
		// this.blocks 是一个 AsyncDependenciesBlock 数组
		for (const block of this.blocks) {
			const { dependencies } = block;

			const modules = dependencies.map(dependency => {
				const dep = /** @type {ContainerExposedDependency} */ (dependency);
				return {
					name: dep.exposedName,
					module: moduleGraph.getModule(dep),
					request: dep.userRequest
				};
			});

			let str;

			if (modules.some(m => !m.module)) {
				str = runtimeTemplate.throwMissingModuleErrorBlock({
					request: modules.map(m => m.request).join(", ")
				});
			} else {
				str = `return ${runtimeTemplate.blockPromise({
					block,
					message: "",
					chunkGraph,
					runtimeRequirements
				})}.then(${runtimeTemplate.returningFunction(
					runtimeTemplate.returningFunction(
						`(${modules
							.map(({ module, request }) =>
								runtimeTemplate.moduleRaw({
									module,
									chunkGraph,
									request,
									weak: false,
									runtimeRequirements
								})
							)
							.join(", ")})`
					)
				)});`;
			}

			getters.push(
				`${JSON.stringify(modules[0].name)}: ${runtimeTemplate.basicFunction(
					"",
					str
				)}`
			);
		}

		// 这里是拼接 mf runtime 代码，每一个 mf expose 模块都会导出一个含有 get 和 init 方法的对象
		const source = Template.asString([
			`var moduleMap = {`,
			Template.indent(getters.join(",\n")),
			"};",
			`var get = ${runtimeTemplate.basicFunction("module, getScope", [
				`${RuntimeGlobals.currentRemoteGetScope} = getScope;`,
				// reusing the getScope variable to avoid creating a new var (and module is also used later)
				"getScope = (",
				Template.indent([
					`${RuntimeGlobals.hasOwnProperty}(moduleMap, module)`,
					Template.indent([
						"? moduleMap[module]()",
						`: Promise.resolve().then(${runtimeTemplate.basicFunction(
							"",
							"throw new Error('Module \"' + module + '\" does not exist in container.');"
						)})`
					])
				]),
				");",
				`${RuntimeGlobals.currentRemoteGetScope} = undefined;`,
				"return getScope;"
			])};`,
			`var init = ${runtimeTemplate.basicFunction("shareScope, initScope", [
				`if (!${RuntimeGlobals.shareScopeMap}) return;`,
				`var name = ${JSON.stringify(this._shareScope)}`,
				`var oldScope = ${RuntimeGlobals.shareScopeMap}[name];`,
				`if(oldScope && oldScope !== shareScope) throw new Error("Container initialization failed as it has already been initialized with a different share scope");`,
				`${RuntimeGlobals.shareScopeMap}[name] = shareScope;`,
				`return ${RuntimeGlobals.initializeSharing}(name, initScope);`
			])};`,
			"",
			"// This exports getters to disallow modifications",
			`${RuntimeGlobals.definePropertyGetters}(exports, {`,
			Template.indent([
				`get: ${runtimeTemplate.returningFunction("get")},`,
				`init: ${runtimeTemplate.returningFunction("init")}`
			]),
			"});"
		]);

		sources.set(
			"javascript",
			this.useSourceMap || this.useSimpleSourceMap
				? new OriginalSource(source, "webpack/container-entry")
				: new RawSource(source)
		);

		return {
			sources,
			runtimeRequirements
		};
	}

	/**
	 * @param {string=} type the source type for which the size should be estimated
	 * @returns {number} the estimated size of the module (must be non-zero)
	 */
	size(type) {
		return 42;
	}

	serialize(context) {
		const { write } = context;
		write(this._name);
		write(this._exposes);
		write(this._shareScope);
		super.serialize(context);
	}

	static deserialize(context) {
		const { read } = context;
		const obj = new ContainerEntryModule(read(), read(), read());
		obj.deserialize(context);
		return obj;
	}
}

makeSerializable(
	ContainerEntryModule,
	"webpack/lib/container/ContainerEntryModule"
);

module.exports = ContainerEntryModule;
