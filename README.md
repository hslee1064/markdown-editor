# Markdown Editor

Notion처럼 입력하는 즉시 서식이 적용되는 VS Code용 WYSIWYG Markdown 에디터 확장입니다.
`#␣`를 치면 바로 제목이 되고, `/`로 블록을 삽입하며, 저장되는 파일은 표준 Markdown 그대로 유지됩니다.

## 주요 기능

**실시간 서식 (Markdown 단축 입력)**

| 입력 | 결과 |
|---|---|
| `#␣` ~ `######␣` | 제목 1–6 |
| `-␣` `*␣` `+␣` | 글머리 목록 |
| `1.␣` | 번호 목록 |
| `[ ]␣` | 할 일 목록 |
| `>␣` | 인용 |
| ` ```lang␣ ` | 코드 블록 (언어 지정) |
| `\| a \| b \|` + Enter | 표 |
| `**굵게**` `*기울임*` `` `코드` `` `~~취소선~~` | 인라인 서식 |

한글 등 IME 입력 상태에서도 동작합니다.

**편집 UI**
- `/` 슬래시 메뉴: 텍스트, 제목, 목록, 할 일, 인용, 코드, 표, 구분선, 이미지
- 텍스트를 선택하면 서식 메뉴(굵게·기울임·취소선·코드·링크) 표시
- 표: 열 경계선을 드래그해 너비 조절, 커서가 표 안에 있으면 행/열 추가·삭제 바 표시
- 코드 블록: 문법 하이라이팅(약 35개 언어, 자동 감지), 언어 선택 드롭다운
- 단축키: `Cmd/Ctrl+B` `I` `E` `K`(링크)

**파일 연동**
- VS Code의 저장·Undo·변경 표시와 그대로 연동 (CustomTextEditor 기반)
- 다른 프로그램이 파일을 수정하면 즉시 반영
- `.md` 기준 상대 경로 이미지 표시
- VS Code 테마 색상과 에디터 폰트 크기 자동 적용

## 표 열 너비 저장 방식

Markdown에는 열 너비 문법이 없기 때문에, 구분선의 `-` 개수로 너비를 저장합니다(1개 = 10px).

```markdown
| 이름 | 설명 |
| ------------ | ------------------------------ |
```

위 표는 120px / 300px로 표시됩니다. 표준 Markdown이므로 GitHub 등 다른 뷰어에서도 정상적으로 렌더링되며, `---`(3개)는 자동 너비를 의미합니다.

## 알아둘 점

- 편집 시 Markdown이 일정한 형식으로 정규화됩니다(예: `*` 목록 → `-`). 파일을 열기만 해서는 바뀌지 않습니다.
- 원시 HTML, 셀 병합, 표 정렬(`:---:`)은 지원하지 않습니다.
- 원문을 직접 편집하려면 명령 팔레트 → **Reopen Editor With…** → **Text Editor**.

## 설치

```bash
npm install
npm run package                     # markdown-editor-0.0.1.vsix 생성
code --install-extension markdown-editor-0.0.1.vsix
```

설치 후 `.md` 파일에서 우클릭 → **Open With…** → **Markdown Editor**, 또는 에디터 상단의 미리보기 아이콘을 누릅니다.
기본 에디터로 쓰려면 `settings.json`에 추가하세요.

```json
"workbench.editorAssociations": { "*.md": "markdownEditor.editor" }
```

## 개발

```bash
npm install
npm run compile      # 확장(tsc) + 웹뷰(esbuild) 빌드
```

VS Code에서 이 폴더를 열고 `F5`로 Extension Development Host를 실행합니다.

```
src/
  extension.ts               확장 진입점, 명령 등록
  markdownEditorProvider.ts  CustomTextEditor: 웹뷰 HTML, 문서 동기화, 파일 감시
webview/
  main.ts                    TipTap 에디터, 슬래시 메뉴, 단축 입력, 표 너비 저장
media/
  editor.css                 에디터 스타일 (VS Code 테마 변수 사용)
  dist/editor.js             웹뷰 번들 (빌드 산출물)
```

에디터 엔진은 [TipTap](https://tiptap.dev) 2.x와 [tiptap-markdown](https://github.com/aguingand/tiptap-markdown), 하이라이팅은 [lowlight](https://github.com/wooorm/lowlight)를 사용합니다.
