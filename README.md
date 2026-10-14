# Envelope

동인 음성 작품을 자막과 함께 듣는 PC 플레이어 (Windows / Linux).

- 작품(폴더) 단위 라이브러리, 이어 듣기, 북마크, 수면 타이머, 배경 이미지
- vtt / srt / lrc 자막, 원문 + 번역 이중 자막, 자막 편집
- 자동 자막: 로컬 Whisper(Vulkan GPU / CPU) 또는 Groq 받아쓰기 + 번역(Google · DeepL · Gemini · OpenAI 호환 LLM)
- 대본 기반 자막: 작품에 들어 있는 대본(txt · pdf · docx)을 음성에 맞춰 자막으로
- 파일 정리: mp3 썸네일(ID3) 넣기, wav → mp3 정리, 깨진 일본어 이름(뷁어) 복구 · 이름 번역 후 실제로 바꾸기(되돌리기 가능)
- 작은 창 · 최소화 모드(재생 바 하나만 남기기)
- 자동 업데이트 (GitHub Releases)

외부로 나가는 것은 사용자가 설정에서 켠 경우뿐입니다: 받아쓰기용 음성(Groq), 번역할 글자(번역 엔진), 작품 코드(DLsite 작품 정보).

## 로컬 받아쓰기 엔진

설정 › 자동 자막에서 CPU 엔진과 모델을 받을 수 있습니다. GPU(Vulkan) 엔진은 `scripts/build-whisper-vulkan.ps1`로 직접 빌드해 설정 › "Vulkan 엔진 넣기"로 넣습니다 (git · CMake · VS 2022 Build Tools · Vulkan SDK 필요).

## 개발

```sh
npm install      # better-sqlite3 Electron용 바이너리도 받습니다
npm run dev
npm test
npm run typecheck
npm run icons    # Env_icon_v2.png → build/ 아이콘
npm run dist     # 설치 파일 (dist/)
```

## 라이선스

MIT
