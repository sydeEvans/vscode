import {ExtensionHostMain} from "vs/workbench/services/extensions/common/extensionHostMain";
import {IExtHostConsumerFileSystem} from "vs/workbench/api/common/extHostFileSystemConsumer";
import {IExtHostRpcService} from "vs/workbench/api/common/extHostRpcService";
import {ILogService} from "vs/platform/log/common/log";
import {ExtHostContext} from "vs/workbench/api/common/extHost.protocol";
import {IExtHostDocumentsAndEditors} from "vs/workbench/api/common/extHostDocumentsAndEditors";
import {ExtHostFileSystemEventService} from "vs/workbench/api/common/extHostFileSystemEventService";
import * as typeConverters from "vs/workbench/api/common/extHostTypeConverters";
import {URI} from "vs/base/common/uri";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function ragdollWorkerInject(extHostMain: ExtensionHostMain, nativePostMessage:(data: any, transferables?: Transferable[]) => void) {
	extHostMain.instaService.invokeFunction(accessor => {
		// const extHostExtensionService = accessor.get(IExtHostExtensionService);
		const extHostConsumerFileSystem = accessor.get(IExtHostConsumerFileSystem);
		const rpcProtocol = accessor.get(IExtHostRpcService);
		const extHostLogService = accessor.get(ILogService);

		const fs = extHostConsumerFileSystem.value;
		const extHostDocumentsAndEditors = rpcProtocol.set(ExtHostContext.ExtHostDocumentsAndEditors, accessor.get(IExtHostDocumentsAndEditors));
		const extHostFileSystemEvent = rpcProtocol.set(ExtHostContext.ExtHostFileSystemEventService, new ExtHostFileSystemEventService(rpcProtocol, extHostLogService, extHostDocumentsAndEditors));

		function createFileSystemWatcher(globPattern: string, ignoreCreateEvents?: boolean, ignoreChangeEvents?: boolean, ignoreDeleteEvents?: boolean){
			return extHostFileSystemEvent.createFileSystemWatcher(typeConverters.GlobPattern.from(globPattern), ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents);
		}
		const watcher = createFileSystemWatcher("**");

		const fsChannel = new MessageChannel();
		nativePostMessage({
			type: '_ragdollEvent',
			channel: fsChannel.port2
		}, [fsChannel.port2]);

		fsChannel.port1.addEventListener('message', (e) => {
			handlerRemoteCommand(e.data);
		});
		fsChannel.port1.start();

		watcher.onDidChange(async (file) => {
			if (file.scheme !== 'memfs') return;
			const fsStat = await fs.stat(file);
			// 1: file 2: Directory
			const fileType = fsStat.type;
			let data:any = {};
			extHostLogService.info('onDidChange', file);
			if (fileType === 1) {
				const fileContent = await fs.readFile(file);
				data = {
					type: 'fileChange',
					data: {
						fspath: file.path,
						content: textDecoder.decode(fileContent)
					}
				};
			} else if (fileType === 2) {
				data = {
					type: 'dirChange',
					data: {
						fspath: file.path
					},
				};
			}
			fsChannel.port1.postMessage(data);
		});

		watcher.onDidDelete(async (file) => {
			if (file.scheme !== 'memfs') return;
			extHostLogService.info('onDidDelete', file);
			const files = await readDir(URI.from({ scheme: 'memfs', path: '/project'}));
			const data = {
				type: 'refresh',
				data: {
					files
				},
			};
			fsChannel.port1.postMessage(data);
		});

		watcher.onDidCreate(async (file) => {
			if (file.scheme !== 'memfs') return;
			extHostLogService.info('onDidCreate', file);
			const data = {
				type: 'fileOrDirCreate',
				data: {
					fspath: file.path
				},
			};
			fsChannel.port1.postMessage(data);
		});

		function handlerRemoteCommand(msg: any) {
			console.log(msg.type, msg);
			switch (msg.type){
				case 'writeFile':
					writeFile(msg.file);
					break;
				default:
					console.warn('不支持的函数');
			}
		}

		function writeFile(file: any) {
			const { code, path } = file;
			fs.writeFile(URI.parse(`memfs:/project${path}`), textEncoder.encode(code));
		}

		async function readDir(root: URI, store: any[] = []) {
			const files = await fs.readDirectory(root);
			await Promise.all(
				files.map(async f => {
					const [fsname, fstype] = f;
					if (fstype === 1) {
						const fileUri = URI.from({scheme: 'memfs', path: root.fsPath + '/' + fsname});
						const fscontent = await fs.readFile(fileUri);
						// 文件
						store.push({
							uri: fileUri,
							fscontent: textDecoder.decode(fscontent)
						});
					} else {
						// 文件夹
						const subRoot = URI.from({scheme: 'memfs', path: root.fsPath + '/' + fsname});
						await readDir(subRoot, store);
					}
				})
			);
			return store;
		}
	});
}