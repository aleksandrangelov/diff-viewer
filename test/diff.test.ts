import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.js'

describe('parseDiff', () => {
  it('parses a modified file with line numbers', () => {
    const [file] = parseDiff(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@ function x() {
 one
-two
+TWO
 three
\\ No newline at end of file
`)
    expect(file).toMatchObject({ path: 'src/a.ts', status: 'M', added: 1, removed: 1, binary: false })
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2 },
      { kind: 'add', text: 'TWO', newNo: 2 },
      { kind: 'ctx', text: 'three', oldNo: 3, newNo: 3 },
    ])
  })

  it('handles added, deleted, renamed, binary and empty files', () => {
    const files = parseDiff(`diff --git a/new file.txt b/new file.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new file.txt
@@ -0,0 +1,2 @@
+hello
+--- not a header
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`)
    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ['new file.txt', 'A', undefined, false],
      ['gone.txt', 'D', undefined, false],
      ['new.ts', 'R', 'old.ts', false],
      ['img.png', 'M', undefined, true],
      ['empty.txt', 'A', undefined, false],
    ])
    expect(files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['hello', '--- not a header'])
  })

  it('unquotes paths git had to escape', () => {
    const [file] = parseDiff(`diff --git "a/tab\\there.txt" "b/tab\\there.txt"
--- "a/tab\\there.txt"
+++ "b/tab\\there.txt"
@@ -1 +1 @@
-x
+y
`)
    expect(file!.path).toBe('tab\there.txt')
  })
})
