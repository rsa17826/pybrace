import * as vscode from "vscode"

const BRACKETS = new Set(["(", ")", "[", "]", "{", "}"])
const OPEN = new Set(["(", "[", "{"])

let decorationTypes: vscode.TextEditorDecorationType[] = []

function getColors(): string[] {
  return vscode.workspace
    .getConfiguration("rainbowBraces")
    .get<
      string[]
    >("colors", ["#e06c75", "#61afef", "#98c379", "#c678dd"])
}

function createDecorationTypes() {
  disposeDecorationTypes()
  decorationTypes = getColors().map((color) =>
    vscode.window.createTextEditorDecorationType({ color }),
  )
}

function disposeDecorationTypes() {
  decorationTypes.forEach((d) => d.dispose())
  decorationTypes = []
}

function updateDecorations(editor: vscode.TextEditor) {
  if (editor.document.languageId !== "python") return

  const text = editor.document.getText()
  const buckets: vscode.Range[][] = decorationTypes.map(() => [])

  let depth = 0
  let inString: false | '"' | "'" | '"""' | "'''" = false
  let inComment = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (ch === "\n") {
      inComment = false
      continue
    }
    if (inComment) continue

    // crude string/comment skipping — see note below
    if (!inString && ch === "#") {
      inComment = true
      continue
    }

    if (!inString && (ch === '"' || ch === "'")) {
      const triple = text.substr(i, 3)
      if (triple === '"""' || triple === "'''") {
        inString = triple as any
        i += 2
        continue
      }
      inString = ch as any
      continue
    } else if (inString) {
      if (inString.length === 1 && ch === inString) {
        inString = false
        continue
      }
      if (inString.length === 3 && text.substr(i, 3) === inString) {
        inString = false
        i += 2
        continue
      }
      continue
    }

    if (!BRACKETS.has(ch)) continue

    const pos = editor.document.positionAt(i)
    const range = new vscode.Range(pos, pos.translate(0, 1))

    if (OPEN.has(ch)) {
      const colorIdx = depth % decorationTypes.length
      buckets[colorIdx].push(range)
      depth++
    } else {
      depth = Math.max(0, depth - 1)
      const colorIdx = depth % decorationTypes.length
      buckets[colorIdx].push(range)
    }
  }

  decorationTypes.forEach((type, idx) =>
    editor.setDecorations(type, buckets[idx]),
  )
}

export function activate(context: vscode.ExtensionContext) {
  createDecorationTypes()

  const trigger = (editor?: vscode.TextEditor) => {
    if (editor) updateDecorations(editor)
  }

  trigger(vscode.window.activeTextEditor)

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(trigger),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor
      if (editor && e.document === editor.document) trigger(editor)
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rainbowBraces")) {
        createDecorationTypes()
        trigger(vscode.window.activeTextEditor)
      }
    }),
  )
}

export function deactivate() {
  disposeDecorationTypes()
}
