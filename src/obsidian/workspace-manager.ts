import { App, Editor, Plugin, MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	McpNotification,
	SelectionChangedParams,
	SelectionRange,
} from "../mcp/types";
import { getAbsolutePath } from "./utils";

export interface WorkspaceManagerConfig {
	onSelectionChange: (notification: McpNotification) => void;
}

/**
 * Cached selection state that persists when focus moves away from editor
 */
export interface CachedSelectionState {
	text: string;
	filePath: string;
	fileUrl: string;
	selection: SelectionRange;
	view: MarkdownView;
	timestamp: number;
}

export class WorkspaceManager {
	private config: WorkspaceManagerConfig;

	/**
	 * Cached selection state - persists when focus moves away from editor.
	 * Used by MCP tools to return selection data even when editor is not focused.
	 */
	private cachedSelectionState: CachedSelectionState | null = null;

	constructor(
		private app: App,
		private plugin: Plugin,
		config: WorkspaceManagerConfig
	) {
		this.config = config;
	}

	setupListeners(): void {
		// Listen for active file changes
		// Always send context, but preserve selection when switching to non-markdown leaf
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const viewType = leaf?.view?.getViewType?.();
				console.debug(`[MCP] active-leaf-change: viewType=${viewType}`);
				this.sendCurrentFileContext();
			})
		);

		// Listen for file opens
		this.plugin.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				// Only update context if a file was actually opened
				if (file) {
					this.sendCurrentFileContext();
				}
			})
		);

		// Listen for DOM selection changes (replaces editor-change polling)
		this.plugin.registerDomEvent(document, "selectionchange", () => {
			this.checkAndSendSelection();
		});
	}

	sendInitialContext(): void {
		this.sendCurrentFileContext();
	}

	private checkAndSendSelection(): void {
		// Check if the selection is within an editable note view
		if (!this.isSelectionInEditableNote()) {
			console.debug("[MCP] checkAndSendSelection: not in editable note, skipping");
			return;
		}

		const activeLeaf = this.app.workspace.activeLeaf;
		const view = activeLeaf?.view;
		const viewType = (view as any)?.getViewType?.();
		const editor = (view as any)?.editor;

		console.debug(`[MCP] checkAndSendSelection: viewType=${viewType}, hasEditor=${!!editor}`);

		if (editor) {
			this.sendSelectionContext(editor);
		}
	}

	private isSelectionInEditableNote(): boolean {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) {
			return false;
		}

		// Get the anchor node of the selection
		const anchorNode = selection.anchorNode;
		if (!anchorNode) {
			return false;
		}

		// Traverse up the DOM tree to find if we're within an editor
		let element =
			anchorNode.nodeType === Node.ELEMENT_NODE
				? (anchorNode as Element)
				: anchorNode.parentElement;

		while (element) {
			// Check for Obsidian editor containers
			// The main editor area has class 'cm-editor' (CodeMirror 6)
			// or 'CodeMirror' (CodeMirror 5) depending on version
			if (
				element.classList.contains("cm-editor") ||
				element.classList.contains("CodeMirror") ||
				element.classList.contains("markdown-source-view") ||
				element.classList.contains("markdown-preview-view")
			) {
				// Additional check: ensure we're in the main workspace, not a modal or settings
				const workspaceElement = element.closest(".workspace");
				const modalElement = element.closest(".modal");
				const settingsElement = element.closest(
					".vertical-tab-content"
				);

				// Return true only if we're in the workspace and not in a modal/settings
				return (
					workspaceElement !== null &&
					modalElement === null &&
					settingsElement === null
				);
			}

			element = element.parentElement;
		}

		return false;
	}

	private sendCurrentFileContext(): void {
		// Use getCurrentSelection() which handles both live editor and cached selection
		// This ensures selection persists when switching to non-markdown leaves
		const currentSelection = this.getCurrentSelection();
		const activeFile = this.app.workspace.getActiveFile();

		const debugMsg = `sendCurrentFileContext: sel=${currentSelection ? 'YES text=' + currentSelection.text?.slice(0,30) + ' fromCache=' + currentSelection.fromCache : 'NULL'}`;
		console.warn(`[MCP-DEBUG] ${debugMsg}`);
		// Write to vault for debugging
		const adapter = this.app.vault.adapter;
		(async () => {
			try {
				const existing = await adapter.read('_mcp-debug.log').catch(() => '');
				await adapter.write('_mcp-debug.log', existing + new Date().toISOString() + ' ' + debugMsg + '\n');
			} catch (e) { console.warn('[MCP-DEBUG] write error:', e); }
		})();

		if (currentSelection && currentSelection.filePath) {
			const params: SelectionChangedParams = {
				text: currentSelection.text,
				filePath: currentSelection.filePath,
				fileUrl: `file://${this.getAbsolutePath(currentSelection.filePath)}`,
				selection: currentSelection.selection,
			};
			this.broadcastSelectionChange(params);
		} else {
			// No selection available (neither live nor cached)
			const params: SelectionChangedParams = {
				text: "",
				filePath: activeFile ? activeFile.path : null,
				fileUrl: activeFile
					? `file://${this.getAbsolutePath(activeFile.path)}`
					: null,
				selection: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
					isEmpty: true,
				},
			};
			this.broadcastSelectionChange(params);
		}
	}

	private sendSelectionContext(editor: Editor): void {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		// Get the current MarkdownView for caching
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		// Use CodeMirror state.selection.main instead of editor.getSelection()
		// because editor.getSelection() returns empty when editor is unfocused
		let selection = "";
		let selectionRange: SelectionRange;

		try {
			const cmEditor = (editor as any).cm as EditorView;
			const state = cmEditor.state;
			const mainSelection = state.selection.main;
			const hasSelection = !mainSelection.empty;

			selection = hasSelection
				? state.doc.sliceString(mainSelection.from, mainSelection.to)
				: "";

			const fromLine = state.doc.lineAt(mainSelection.from);
			const toLine = state.doc.lineAt(mainSelection.to);

			selectionRange = hasSelection
				? {
						start: {
							line: fromLine.number - 1,
							character: mainSelection.from - fromLine.from,
						},
						end: {
							line: toLine.number - 1,
							character: mainSelection.to - toLine.from,
						},
						isEmpty: false,
					}
				: {
						start: {
							line: fromLine.number - 1,
							character: mainSelection.from - fromLine.from,
						},
						end: {
							line: fromLine.number - 1,
							character: mainSelection.from - fromLine.from,
						},
						isEmpty: true,
					};
		} catch (e) {
			// Fall back to editor API if CM access fails
			const cursor = editor.getCursor();
			selection = editor.getSelection();
			const hasSelection = selection.length > 0;

			if (hasSelection) {
				const from = editor.getCursor("from");
				const to = editor.getCursor("to");
				selectionRange = {
					start: { line: from.line, character: from.ch },
					end: { line: to.line, character: to.ch },
					isEmpty: false,
				};
			} else {
				selectionRange = {
					start: { line: cursor.line, character: cursor.ch },
					end: { line: cursor.line, character: cursor.ch },
					isEmpty: true,
				};
			}
		}

		const filePath = activeFile.path;
		const fileUrl = `file://${this.getAbsolutePath(activeFile.path)}`;

		const params: SelectionChangedParams = {
			text: selection,
			filePath,
			fileUrl,
			selection: selectionRange,
		};

		// Cache the selection state for use when focus moves away
		if (activeView) {
			this.cachedSelectionState = {
				text: selection,
				filePath,
				fileUrl,
				selection: selectionRange,
				view: activeView,
				timestamp: Date.now(),
			};
		}

		this.broadcastSelectionChange(params);
	}

	private broadcastSelectionChange(params: SelectionChangedParams): void {
		const hasSelection = params.text && params.text.length > 0;
		console.warn(`[MCP-WM] BROADCAST: file=${params.filePath}, hasSelection=${hasSelection}`);

		const message: McpNotification = {
			jsonrpc: "2.0",
			method: "selection_changed",
			params,
		};

		this.config.onSelectionChange(message);
	}

	private getAbsolutePath(relativePath: string): string {
		const basePath =
			(this.app.vault.adapter as any).getBasePath?.() || process.cwd();
		return getAbsolutePath(relativePath, basePath);
	}

	/**
	 * Get the cached selection state.
	 * Returns the last known selection even when focus has moved away from the editor.
	 * The cached view reference can be used to query current selection if still valid.
	 */
	getCachedSelection(): CachedSelectionState | null {
		return this.cachedSelectionState;
	}

	/**
	 * Get current selection, trying live data first, falling back to cache.
	 * This is the preferred method for MCP tools to use.
	 */
	getCurrentSelection(): {
		text: string;
		filePath: string | null;
		selection: SelectionRange;
		fromCache: boolean;
	} | null {
		// Try to get live selection from active view
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		console.warn(`[MCP-DEBUG] getCurrentSelection: activeView=${activeView ? 'YES' : 'NO'}, cachedState=${this.cachedSelectionState ? 'YES' : 'NO'}`);

		if (activeView) {
			const editor = activeView.editor;
			const activeFile = this.app.workspace.getActiveFile();
			if (editor && activeFile) {
				// Always use CodeMirror state.selection.main instead of editor.getSelection()
				// because editor.getSelection() returns empty when the editor is unfocused
				// (e.g., when user clicks to Claude panel), but CM state persists
				try {
					const cmEditor = (editor as any).cm as EditorView;
					const state = cmEditor.state;
					const mainSelection = state.selection.main;
					const hasSelection = !mainSelection.empty;

					// Get text from doc if there's a selection
					const text = hasSelection
						? state.doc.sliceString(
								mainSelection.from,
								mainSelection.to
							)
						: "";

					// Get line/character positions
					const fromLine = state.doc.lineAt(mainSelection.from);
					const toLine = state.doc.lineAt(mainSelection.to);

					const selectionRange: SelectionRange = hasSelection
						? {
								start: {
									line: fromLine.number - 1,
									character: mainSelection.from - fromLine.from,
								},
								end: {
									line: toLine.number - 1,
									character: mainSelection.to - toLine.from,
								},
								isEmpty: false,
							}
						: {
								start: {
									line: fromLine.number - 1,
									character: mainSelection.from - fromLine.from,
								},
								end: {
									line: fromLine.number - 1,
									character: mainSelection.from - fromLine.from,
								},
								isEmpty: true,
							};

					return {
						text,
						filePath: activeFile.path,
						selection: selectionRange,
						fromCache: false,
					};
				} catch (e) {
					// Fall back to editor API if CM access fails
					const selection = editor.getSelection();
					const cursor = editor.getCursor();
					const hasSelection = selection.length > 0;

					let selectionRange: SelectionRange;
					if (hasSelection) {
						const from = editor.getCursor("from");
						const to = editor.getCursor("to");
						selectionRange = {
							start: { line: from.line, character: from.ch },
							end: { line: to.line, character: to.ch },
							isEmpty: false,
						};
					} else {
						selectionRange = {
							start: { line: cursor.line, character: cursor.ch },
							end: { line: cursor.line, character: cursor.ch },
							isEmpty: true,
						};
					}

					return {
						text: selection,
						filePath: activeFile.path,
						selection: selectionRange,
						fromCache: false,
					};
				}
			}
		}

		// Fall back to cached selection if available (when no active view)
		if (this.cachedSelectionState) {
			// Try to get fresh selection from the cached view using CodeMirror state
			if (this.cachedSelectionState.view) {
				try {
					const cmEditor = (
						this.cachedSelectionState.view.editor as any
					).cm as EditorView;
					const state = cmEditor.state;
					const mainSelection = state.selection.main;
					const hasSelection = !mainSelection.empty;

					const text = hasSelection
						? state.doc.sliceString(
								mainSelection.from,
								mainSelection.to
							)
						: "";

					const fromLine = state.doc.lineAt(mainSelection.from);
					const toLine = state.doc.lineAt(mainSelection.to);

					const selectionRange: SelectionRange = hasSelection
						? {
								start: {
									line: fromLine.number - 1,
									character: mainSelection.from - fromLine.from,
								},
								end: {
									line: toLine.number - 1,
									character: mainSelection.to - toLine.from,
								},
								isEmpty: false,
							}
						: {
								start: {
									line: fromLine.number - 1,
									character: mainSelection.from - fromLine.from,
								},
								end: {
									line: fromLine.number - 1,
									character: mainSelection.from - fromLine.from,
								},
								isEmpty: true,
							};

					return {
						text,
						filePath: this.cachedSelectionState.filePath,
						selection: selectionRange,
						fromCache: false,
					};
				} catch (e) {
					// View might be destroyed, fall through to cached data
				}
			}

			// Return the cached data as-is
			return {
				text: this.cachedSelectionState.text,
				filePath: this.cachedSelectionState.filePath,
				selection: this.cachedSelectionState.selection,
				fromCache: true,
			};
		}

		return null;
	}
}
