/**
 * CodeMirror 6 extension for persistent selection highlighting.
 *
 * Problem: When the editor loses focus (e.g., clicking on Claude terminal),
 * CodeMirror clears the visual selection highlight even though the selection
 * state is preserved internally.
 *
 * Solution: This extension uses EditorView.focusChangeEffect to dispatch
 * decoration effects when focus changes. When the editor loses focus and
 * there's a selection, we add decoration marks. When focus is regained,
 * we clear them and let native selection highlighting take over.
 */
import {
	StateField,
	StateEffect,
	RangeSet,
	Transaction,
	EditorState,
} from "@codemirror/state";
import { EditorView, Decoration, DecorationSet } from "@codemirror/view";

/**
 * Effect to set the selection highlight decorations
 */
const setSelectionHighlight = StateEffect.define<{
	from: number;
	to: number;
} | null>();

/**
 * Decoration mark for unfocused selection - uses the same CSS class
 * that CodeMirror uses for focused selection so it inherits theme styles
 */
const selectionMark = Decoration.mark({
	class: "cm-selectionBackground",
});

/**
 * StateField that holds the decoration set for unfocused selection
 */
const selectionHighlightField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},

	update(decorations: DecorationSet, tr: Transaction): DecorationSet {
		// Check for our effect
		for (const effect of tr.effects) {
			if (effect.is(setSelectionHighlight)) {
				if (effect.value === null) {
					return Decoration.none;
				}
				// Create new decoration for the selection range
				const { from, to } = effect.value;
				if (from < to && to <= tr.state.doc.length) {
					return RangeSet.of([selectionMark.range(from, to)]);
				}
				return Decoration.none;
			}
		}

		// Map decorations through document changes
		if (tr.docChanged && decorations !== Decoration.none) {
			return decorations.map(tr.changes);
		}

		return decorations;
	},

	provide: (field) => EditorView.decorations.from(field),
});

/**
 * Focus change handler using EditorView.focusChangeEffect facet.
 * This is the most reliable way to detect focus changes in CodeMirror 6.
 */
const focusChangeHandler = EditorView.focusChangeEffect.of(
	(state: EditorState, focusing: boolean) => {
		if (focusing) {
			// Gaining focus - clear our decoration marks
			return setSelectionHighlight.of(null);
		} else {
			// Losing focus - show decoration marks for current selection
			const selection = state.selection.main;
			if (!selection.empty) {
				return setSelectionHighlight.of({
					from: selection.from,
					to: selection.to,
				});
			}
		}
		return null;
	}
);

/**
 * Extension bundle for persistent selection highlighting.
 * Register this with Obsidian's plugin.registerEditorExtension()
 */
export const selectionHighlightExtension = [
	selectionHighlightField,
	focusChangeHandler,
];
