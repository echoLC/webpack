/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra, Zackary Jackson @ScriptedAlchemy, Marais Rossouw @maraisr
*/

"use strict";

const createSchemaValidation = require("../util/create-schema-validation");
const ContainerEntryDependency = require("./ContainerEntryDependency");
const ContainerEntryModuleFactory = require("./ContainerEntryModuleFactory");
const ContainerExposedDependency = require("./ContainerExposedDependency");
const { parseOptions } = require("./options");

/** @typedef {import("../../declarations/plugins/container/ContainerPlugin").ContainerPluginOptions} ContainerPluginOptions */
/** @typedef {import("../../declarations/plugins/container/ContainerPlugin").LibraryType} LibraryType */
/** @typedef {import("../Compiler")} Compiler */

const validate = createSchemaValidation(
	require("../../schemas/plugins/container/ContainerPlugin.check.js"),
	() => require("../../schemas/plugins/container/ContainerPlugin.json"),
	{
		name: "Container Plugin",
		baseDataPath: "options"
	}
);

const PLUGIN_NAME = "ContainerPlugin";

class ContainerPlugin {
	/**
	 * @param {ContainerPluginOptions} options options
	 */
	constructor(options) {
		validate(options);

		this._options = {
			name: options.name,
			/* 共享作用域的名称 */
			shareScope: options.shareScope || "default",
			/* 模块构建产物的类型，类型为 LibraryType */
			library: options.library || {
				type: "var",
				name: options.name
			},
			// 设置了该选项，会单独为 mf 相关的模块创建一个指定名字的 runtime
			runtime: options.runtime,
			filename: options.filename || undefined,
			// container 导出的模块
			exposes: parseOptions(
				options.exposes,
				item => ({
					import: Array.isArray(item) ? item : [item],
					name: undefined
				}),
				item => ({
					import: Array.isArray(item.import) ? item.import : [item.import],
					name: item.name || undefined
				})
			)
		};
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		const { name, exposes, shareScope, filename, library, runtime } =
			this._options;

		// 	enabledLibraryTypes 专门存储 entry 需要输出的 library 类型，然后被 EnableLibraryPlugin 插件消费，
		// 在构建生成最终产物的时候决定 bundle 的 library 的类型
		compiler.options.output.enabledLibraryTypes.push(library.type);

		// 监听 make hook，这个钩子在完成本次构建过程 compilation 创建之前触发，是一个 AsyncParallelHook 类型的 hook
		compiler.hooks.make.tapAsync(PLUGIN_NAME, (compilation, callback) => {
			// 根据 expose 配置创建 dep
			const dep = new ContainerEntryDependency(name, exposes, shareScope);
			dep.loc = { name };

			// 所有的 entry 都会调用 compilation.addEntry 添加到构建流程中
			compilation.addEntry(
				compilation.options.context,
				dep,
				{
					name,
					filename,
					runtime,
					library
				},
				error => {
					if (error) return callback(error);
					callback();
				}
			);
		});

		compiler.hooks.thisCompilation.tap(
			PLUGIN_NAME,
			(compilation, { normalModuleFactory }) => {
				// 对于特殊的 dependency 一般都有自己的 entry factory，MF 下的 dep 对应的是 ContainerEntryModuleFactory
				compilation.dependencyFactories.set(
					ContainerEntryDependency,
					new ContainerEntryModuleFactory()
				);

				// 而 expose 出去的 dependency 则使用正常的 normalModuleFactory
				compilation.dependencyFactories.set(
					ContainerExposedDependency,
					normalModuleFactory
				);
			}
		);
	}
}

module.exports = ContainerPlugin;
