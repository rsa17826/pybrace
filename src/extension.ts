import * as vscode from "vscode"

interface StackFrame {
  indent: number
  line: number
  lastBodyLine: number
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
    after: {
      contentText: "{",
      color,
      fontWeight: "bold",
      margin: "0 0 0 0.2em",
    },
  })
}

function makeCloseDecoType(color: string) {
  return vscode.window.createTextEditorDecorationType({
    after: {
      contentText: "}",
      color,
      fontWeight: "bold",
      // forces the } onto its own line below the last body line
      textDecoration: "none; display: block; margin-top: 0.1em;",
    },
  })
}

// hides the real ':' character so '{' can visually stand in for it
let colonHiderType: vscode.TextEditorDecorationType | undefined

let openTypes: vscode.TextEditorDecorationType[] = []
let closeTypes: vscode.TextEditorDecorationType[] = []

function createDecorationTypes() {
  disposeDecorationTypes()
  const colors = getColors()
  openTypes = colors.map((c) => makeOpenDecoType(c))
  closeTypes = colors.map((c) => makeCloseDecoType(c))
  colonHiderType = vscode.window.createTextEditorDecorationType({
    textDecoration: "none; display: none;",
  })
}

function disposeDecorationTypes() {
  ;[...openTypes, ...closeTypes].forEach((d) => d.dispose())
  openTypes = []
  closeTypes = []
  if (colonHiderType) {
    colonHiderType.dispose()
    colonHiderType = undefined
  }
}

function stripTrailingComment(s: string): string {
  const idx = s.indexOf("#")
  return idx === -1 ? s : s.slice(0, idx).trim()
}

function updateDecorations(editor: vscode.TextEditor) {
  if (editor.document.languageId !== "python") return
  if (!colonHiderType) return

  const doc = editor.document
  const lineCount = doc.lineCount
  const n = openTypes.length

  const openBuckets: vscode.DecorationOptions[][] = openTypes.map(
    () => [],
  )
  const closeBuckets: vscode.DecorationOptions[][] = closeTypes.map(
    () => [],
  )
  const hideColonRanges: vscode.Range[] = []

  const stack: StackFrame[] = []

  for (let i = 0; i < lineCount; i++) {
    const line = doc.lineAt(i)
    const text = line.text
    const trimmed = text.trim()

    if (trimmed.length === 0 || trimmed.startsWith("#")) continue

    const indent = text.length - text.trimStart().length

    // pop any frames we've dedented out of (including sibling headers at
    // the same indent level), emitting a virtual '}' for each
    while (
      stack.length > 0 &&
      indent <= stack[stack.length - 1].indent
    ) {
      const frame = stack.pop()!
      const depth = stack.length
      const colorIdx = depth % n
      const closeLine = doc.lineAt(frame.lastBodyLine)
      const pos = closeLine.range.end
      closeBuckets[colorIdx].push({
        range: new vscode.Range(pos, pos),
      })
    }

    // this line belongs to whatever frame is currently on top of the stack
    if (stack.length > 0) {
      stack[stack.length - 1].lastBodyLine = i
    }

    const codePart = stripTrailingComment(trimmed)
    if (codePart.endsWith(":")) {
      const depth = stack.length
      const colorIdx = depth % n
      const colonCol = text.lastIndexOf(":")

      // hide the real colon
      hideColonRanges.push(
        new vscode.Range(
          new vscode.Position(i, colonCol),
          new vscode.Position(i, colonCol + 1),
        ),
      )

      // draw '{' in its place
      const bracePos = new vscode.Position(i, colonCol)
      openBuckets[colorIdx].push({
        range: new vscode.Range(bracePos, bracePos),
      })

      stack.push({ indent, line: i, lastBodyLine: i })
    }
  }

  // close anything still open at EOF
  while (stack.length > 0) {
    const frame = stack.pop()!
    const depth = stack.length
    const colorIdx = depth % n
    const closeLine = doc.lineAt(frame.lastBodyLine)
    const pos = closeLine.range.end
    closeBuckets[colorIdx].push({ range: new vscode.Range(pos, pos) })
  }

  openTypes.forEach((type, idx) =>
    editor.setDecorations(type, openBuckets[idx]),
  )
  closeTypes.forEach((type, idx) =>
    editor.setDecorations(type, closeBuckets[idx]),
  )
  editor.setDecorations(colonHiderType, hideColonRanges)
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
