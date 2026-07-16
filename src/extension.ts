import * as vscode from "vscode"

interface StackFrame {
  indent: number
  line: number
  lastBodyLine: number
  depth: number // nesting depth captured at push time, used for stable coloring
}

function getColors(): string[] {
  return vscode.workspace
    .getConfiguration("rainbowBraces")
    .get<
      string[]
    >("colors", ["#e06c75", "#61afef", "#98c379", "#c678dd", "#d19a66", "#56b6c2"])
}

function makeOpenDecoType(color: string) {
  return vscode.window.createTextEditorDecorationType({
    color: "transparent",
    after: {
      contentText: "{ ",
      color,
      fontWeight: "bold;",
    },
  })
}

function makeCloseDecoType(color: string) {
  return vscode.window.createTextEditorDecorationType({
    after: {
      contentText: "}",
      color,
      fontWeight: "bold",
      textDecoration:
        "none; white-space: pre-wrap; display: inline-block;",
      // textDecoration: "none; white-space: pre-wrap; display: block;",
    },
  })
}

let openTypes: vscode.TextEditorDecorationType[] = []
let closeTypes: vscode.TextEditorDecorationType[] = []

const MAX_DEPTH = 64 // Handle up to 64 levels of nesting safely

function createDecorationTypes() {
  disposeDecorationTypes()
  const colors = getColors()
  const n = colors.length

  openTypes = colors.map((c) => makeOpenDecoType(c))

  // FIX 1: Generate closing decoration types for every depth level.
  // This allows us to control the exact stack order of the braces.
  closeTypes = Array.from({ length: MAX_DEPTH }, (_, i) =>
    makeCloseDecoType(colors[i % n]),
  )
}

function disposeDecorationTypes() {
  ;[...openTypes, ...closeTypes].forEach((d) => d.dispose())
  openTypes = []
  closeTypes = []
}

function stripTrailingComment(s: string): string {
  const idx = s.indexOf("#")
  return idx === -1 ? s : s.slice(0, idx).trim()
}

function updateDecorations(editor: vscode.TextEditor) {
  if (editor.document.languageId !== "python") return

  const doc = editor.document
  const lineCount = doc.lineCount
  const n = openTypes.length

  const openBuckets: vscode.DecorationOptions[][] = openTypes.map(
    () => [],
  )
  const closeBuckets: vscode.DecorationOptions[][] = closeTypes.map(
    () => [],
  )
  const stack: StackFrame[] = []

  for (let i = 0; i < lineCount; i++) {
    const line = doc.lineAt(i)
    const text = line.text
    const trimmed = text.trim()

    if (trimmed.length === 0 || trimmed.startsWith("#")) continue

    const indent = text.length - text.trimStart().length

    // pop any frames we've dedented out of (including sibling headers at
    // the same indent level), emitting a virtual '}' for each
    var lineUseCount = 0
    var lastUsedLine = 0
    while (
      stack.length > 0 &&
      indent <= stack[stack.length - 1].indent
    ) {
      const frame = stack.pop()!
      const colorIdx = frame.depth % n
      var l = frame.lastBodyLine + 1
      if (l == lastUsedLine) {
        l += ++lineUseCount
      } else {
        lineUseCount = 0
      }
      lastUsedLine = frame.lastBodyLine + 1
      const closeLine = doc.lineAt(l)
      var pos = closeLine.range.start
      closeBuckets[colorIdx].push({
        range: new vscode.Range(pos, pos),
        renderOptions: {
          after: {
            // align the '}' under its matching 'if' by indenting with ch units
            margin: `0.1em 0 0 ${frame.indent}ch`,
          },
        },
      })
    }

    for (const frame of stack) {
      frame.lastBodyLine = i
    }

    const codePart = stripTrailingComment(trimmed)
    if (codePart.endsWith(":")) {
      const depth = stack.length
      const colorIdx = depth % n
      const colonCol = text.lastIndexOf(":")

      openBuckets[colorIdx].push({
        range: new vscode.Range(
          new vscode.Position(i, colonCol),
          new vscode.Position(i, colonCol + 1),
        ),
      })

      stack.push({ indent, line: i, lastBodyLine: i, depth })
    }
  }

  // close anything still open at EOF
  while (stack.length > 0) {
    const frame = stack.pop()!
    const colorIdx = frame.depth % n
    const closeLine = doc.lineAt(frame.lastBodyLine)
    const pos = closeLine.range.end
    closeBuckets[colorIdx].push({
      range: new vscode.Range(pos, pos),
      renderOptions: {
        after: {
          margin: `0.1em 0 0 ${frame.indent}ch`,
        },
      },
    })
  }

  openTypes.forEach((type, idx) =>
    editor.setDecorations(type, openBuckets[idx]),
  )

  // FIX: Apply closing decorations in reverse order.
  // Because VS Code renders block decorations sequentially, applying them
  // from right-to-left/deepest-to-shallowest forces the inner brace
  // (which has a higher depth/colorIdx) to render on top of the outer brace.
  for (let idx = closeTypes.length - 1; idx >= 0; idx--) {
    editor.setDecorations(closeTypes[idx], closeBuckets[idx])
  }
}

let timeout: NodeJS.Timeout | undefined
function scheduleUpdate(editor?: vscode.TextEditor) {
  if (!editor) return
  if (timeout) clearTimeout(timeout)
  timeout = setTimeout(() => updateDecorations(editor), 150)
}

export function activate(context: vscode.ExtensionContext) {
  createDecorationTypes()
  scheduleUpdate(vscode.window.activeTextEditor)

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(scheduleUpdate),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor
      if (editor && e.document === editor.document)
        scheduleUpdate(editor)
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rainbowBraces")) {
        createDecorationTypes()
        scheduleUpdate(vscode.window.activeTextEditor)
      }
    }),
  )
}

export function deactivate() {
  disposeDecorationTypes()
}
