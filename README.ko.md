# N2 Loom

실시간 응답, 작업 기록 복원, 검증된 도구 실행을 연결하는 AI 대화 모듈입니다.

[English documentation](README.md)

모델 제공자 하나를 등록하면 대화형 에이전트로 사용할 수 있습니다. Hecaton이 등록된 도구를 실행하고, N2R이 작업 전 준비와 작업 후 검증을 강제하며, Mimir가 Soul 공통 DB에 경험을 저장합니다. 대화 버전, 모델 요청, 도구 실행 영수증을 보관하여 프로세스 재시작 후에도 작업을 이어갑니다.

## 설치

Node.js 22 이상과 사용할 모델 엔드포인트가 필요합니다.

```sh
npm install https://github.com/choihyunsus/n2-loom/releases/download/v1.0.0/n2-loom-1.0.0.tgz
```

이번 버전은 GitHub Releases로 배포합니다. 소스에서 실행하려면 `npm ci`와 `npm run build`를 차례로 실행합니다.

## 대화 시작

아래 예제를 `dialogue.mjs`로 저장합니다. `N2_LOOM_MODEL`에는 Ollama 서버에 설치된 모델 이름을 설정합니다.

```js
import { Loom, ollamaChat } from 'n2-loom';

const loom = new Loom({
  dbPath: './data/mimir.db',
  project: 'demo',
  agent: 'assistant',
  limits: { contextBytes: 3072, maxOutputTokens: 256 },
  provider: ollamaChat({
    id: 'local',
    model: process.env.N2_LOOM_MODEL,
    think: false,
    contextLength: 4096,
  }),
});

try {
  const result = await loom.run(
    {
      runId: 'greeting-1',
      conversationId: 'desk',
      message: '짧게 한 문장으로 인사해줘.',
      mode: 'chat',
    },
    {
      onEvent(event) {
        if (event.type === 'delta') process.stdout.write(event.data.text);
      },
    },
  );
  console.log(result.success, result.verification, result.experienceId);
} finally {
  await loom.close();
}
```

CommonJS에서는 `require('n2-loom')`으로 같은 API를 가져올 수 있습니다. Ollama 기본 주소는 `http://127.0.0.1:11434/api/chat`입니다.

기본 `agent` 모드는 등록된 도구를 사용합니다. `chat` 모드는 텍스트 응답을 요청합니다. 두 모드 모두 필수 작업 절차를 거칩니다.

## 모델 제공자와 스트리밍

| 함수 | 통신 형식 | 사용자에게 보이는 텍스트 |
|---|---|---|
| `openAIResponses` | Responses SSE | 도착하는 대로 전달 |
| `anthropicMessages` | Messages SSE | 도착하는 대로 전달 |
| `geminiInteractions` | Interactions SSE | 도착하는 대로 전달 |
| `openAICompatible` | Chat Completions SSE | 도착하는 대로 전달 |
| `ollamaChat` | Ollama NDJSON | native 도구 모드에서 실시간 전달 |

각 함수에 `id`와 `model`을 명시합니다. 클라우드 제공자는 `apiKey`를 받습니다. `endpoint`에는 API 경로까지 포함한 전체 URL을 넣습니다. Ollama는 `toolMode`, `contextLength`, `think`도 지원합니다. JSON 도구 모드는 전체 응답을 검증한 뒤 텍스트를 전달하며 `textStreaming: false`로 표시합니다.

모델 서버의 컨텍스트 크기에 맞춰 `limits.contextBytes`와 `maxOutputTokens`를 설정합니다. 컨텍스트 제한은 직렬화한 바이트 수를 기준으로 합니다. 사용자 제공자는 각 외부 요청 직전에 `request.onAttempt()`를 호출하여 재시도 예산을 정확하게 기록합니다.

제공자별 호출 ID와 비공개 연속 실행 데이터는 다음 모델 요청을 위해 원형대로 보관합니다. 화면에 전달하는 이벤트에는 공개 텍스트를 담습니다. Gumiho의 `ModelProvider` 계약을 따르는 사용자 제공자도 사용할 수 있습니다. 직접 스트리밍하려면 `stream(request, onText)`와 `textStreaming`을 구현합니다. 클래스 메서드의 `this` 연결도 보존합니다.

HTTP 통신에는 UTF-8 검증, 프레임·응답 크기 제한, 시간 제한과 취소 처리가 적용됩니다. 스트림 수신을 시작하기 전의 지정된 429/503 오류는 재시도할 수 있습니다. 일부 응답을 받은 뒤 끊기면 해당 시도의 예산을 유지한 채 복원 가능한 상태로 남습니다.

## 도구와 작업 검증

`tools`에 Hecaton 도구 정의를 등록합니다. 도구마다 이름, 버전, 입력 스키마와 실행 함수를 명시합니다. 모델에는 작은 도구 스키마 묶음을 제공하며, 읽기 전용 `loom_discover`로 전체 등록 목록을 검색할 수 있습니다. 실제 호출마다 Hecaton이 입력과 실행 권한을 검사합니다.

도구는 모델이 요청한 순서대로 실행됩니다. 실행 의도를 먼저 기록하고 결과 영수증을 남깁니다. MCP 도구는 같은 DB·프로젝트·에이전트 범위에서 Hecaton으로 승인된 바인딩을 먼저 가져온 뒤, Loom에 대응하는 `mcpServers` 설정을 전달합니다.

필요하면 버전이 있는 `confirmation.request(context)`를 등록하여 변경 작업을 확인받을 수 있습니다. 확인 요청에는 전체 인자, 도구 정의, 요청 ID, 만료 시각과 취소 신호가 포함되며 데이터 변경이 차단됩니다. 기본 확인 시간은 60초입니다.

기본 검증은 프로토콜 완료 여부와 기록된 도구 결과를 확인하며 `kind: 'protocol'`로 표시합니다. `verifier.verify(context)`를 등록하면 실제 파일, 서비스 상태 등 애플리케이션 결과를 검사하고 `kind: 'host'`, 요약, 선택적 근거를 저장합니다. 도구 실패 후 최종 성공을 인정하려면 호스트 검증이 필요합니다. `preparation.prepare(context)`로 작업 전 조건도 검사할 수 있습니다. 준비·검증 함수는 반복 가능한 확인 작업으로 구현합니다.

## 중단과 복원

- 새 작업에는 새 `runId`를 사용합니다. 중단된 작업은 같은 ID, 입력, 함수 버전과 설정으로 재시도합니다.
- 완료된 작업은 기존 영수증과 `cached: true`를 반환합니다.
- 진행 중이던 모델 요청을 다시 시도할 때도 누적 요청·출력 예산을 유지합니다.
- 도구의 실제 실행 결과가 불확실하면 Hecaton 요청 ID가 제공됩니다. `toolStatus(id)`와 실제 외부 상태를 확인한 뒤 `reconcileTool(id, result, evidence)`로 관찰한 결과를 기록하고 재개합니다.
- 대화 버전과 소유권을 검사하여 새 작업 이후 이전의 중단된 작업에서 오는 쓰기를 차단합니다.
- 최종 결과, 공통 경험, 대화 기록, 체크포인트, 종료 이벤트를 하나의 트랜잭션으로 저장합니다.

`status(runId)`, `history(limit, offset)`, `conversation(id)`, `events(runId, afterSequence, limit)`로 상태를 조회합니다. `cancel(runId)`는 지정한 실행을 취소합니다. `close()`는 실행 중인 작업을 취소하고 소유한 연결을 정리합니다.

이벤트에는 저장된 일련번호가 있습니다. 재연결할 때 `afterSequence`를 지정하며, 다시 전달된 이벤트에는 `replay: true`가 붙습니다. 끊긴 모델 응답을 화면에서 교체할 때는 `turn`과 `attempt`별로 텍스트를 묶습니다. 최종 결과에는 채택된 전체 출력과 실패 사유를 담은 `error`가 있습니다.

컨텍스트가 커지면 출처가 표시된 발췌와 전체 실행 기록 링크로 줄여 다음 세대에 전달합니다. 이때도 누적 예산은 유지합니다. 서로 다른 작업 사이에는 제한된 사용자·어시스턴트 대화문을 복원합니다. 한 작업 안의 도구 연속 실행에는 제공자 고유 데이터를 그대로 사용합니다.

## Soul 공통 DB

다른 모듈과 같은 SQLite 파일 및 명시적인 `project`, `agent` 값을 사용합니다. 공통 경험은 Mimir에 저장하고, Loom 자체 상태에는 다음 일곱 테이블을 사용합니다.

```text
loom_conversations  loom_runs        loom_models
loom_tools          loom_events      loom_checkpoints
loom_leases
```

`meta`에 모듈 스키마 버전 1을 기록합니다. 레코드에는 무결성 해시와 JSON 크기 제한을 적용합니다. 일부 테이블만 존재하거나 호환되지 않는 스키마는 명시적으로 마이그레이션해야 합니다. Soul 체크포인트와 각 모듈의 자체 기록은 소유 범위별로 관리합니다.

Mimir Rust 백엔드와 better-sqlite3 폴백은 같은 저장 계약을 사용합니다. 경험, 대화와 체크포인트를 재사용하는 애플리케이션 수준의 학습을 지원합니다. 모델 가중치와 파인튜닝은 모델 호스트가 관리합니다.

같은 프로젝트·에이전트 범위에서는 하나의 논리적 작업이 실행권을 가집니다. Loom과 Gumiho 작업은 같은 범위에서 순서대로 실행합니다. Loom 제공자 어댑터는 Gumiho의 제공자 계약도 구현하므로 구미호 꼬리에서 재사용할 수 있습니다.

## 실행 예산

| 항목 | 기본값 |
|---|---|
| 모델 턴 / HTTP 시도 / 도구 호출 | 50 / 64 / 128 |
| 실패한 도구 호출 / 컨텍스트 세대 | 5 / 10 |
| 요청별 출력 토큰 / 누적 예약 토큰 | 2,048 / 131,072 |
| 모델 컨텍스트 | 직렬화한 데이터 96,000바이트 |
| 모델 요청 / 전체 실행 기간 | 120초 / 1시간 |
| 이벤트 수신 함수 / 사용자 확인 | 30초 / 60초 |
| 이벤트 수 / 이벤트 데이터 | 32,768개 / 8 MiB |
| 실행 기록 데이터 예산 | 32 MiB |

`limits`에서 지원 범위 안의 값을 지정합니다. 요청·도구·출력 예약은 재시도 후에도 누적됩니다. 전체 실행 기간은 작업 생성 시점부터 계산합니다. 기간이 지난 뒤에도 이미 완료된 도구 영수증을 대화에 반영할 수 있으며, 추가 모델 요청과 새로운 실행은 종료됩니다.

메시지는 64 KiB, 시스템 지시는 16 KiB, 초기 이력은 최대 200개·전체 1 MiB를 지원합니다. 최종 표시 출력은 128 KiB입니다. 변경 파일 요약은 최대 1,024개·64 KiB이며 호출별 전체 보고는 도구 영수증에 보관합니다. 기록 예산은 직렬화한 데이터를 대상으로 하며, DB 보관 정책과 운영체제 자원 제한은 호스트에서 설정합니다.

## CLI와 MCP

PowerShell에서 아래처럼 실행할 수 있습니다.

```powershell
n2-loom run --db ./data/mimir.db --project demo --agent assistant --provider ollama --model YOUR_INSTALLED_MODEL --run-id greeting-1 --conversation-id desk --message "안녕" --stream
n2-loom status --db ./data/mimir.db --project demo --agent assistant --run-id greeting-1
n2-loom help
```

`--stream`은 이벤트와 최종 결과를 줄 단위 JSON으로 출력합니다. 실패한 작업은 실패 종료 코드를 반환합니다. 조회 명령은 기존 저장소의 읽기 전용 연결로 상태를 확인합니다. `--request file.json`으로 전체 요청을 전달할 수도 있습니다. 요청·설정 파일은 BOM이 있는 UTF-8도 지원합니다.

`--host trusted-local.cjs`는 사용자가 지정한 로컬 JavaScript 함수를 불러옵니다. `examples/host.cjs`에는 로컬 제공자와 읽기 전용 단어 수 계산 도구가 있습니다. 예제를 사용할 때는 `N2_LOOM_MODEL`을 설정합니다. CLI의 클라우드 인증에는 `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` 환경변수를 사용합니다.

```powershell
n2-loom mcp --db ./data/mimir.db --project demo --agent assistant --host ./host.cjs
```

MCP에는 다음 열 개 도구가 있습니다.

```text
loom_run           loom_cancel        loom_status
loom_read          loom_events        loom_history
loom_conversation  loom_tools         loom_tool_status
loom_reconcile
```

응답은 크기가 제한된 미리보기를 제공합니다. `loom_read`로 전체 JSON을 유니코드 문자 단위로 읽고 페이지 사이의 SHA-256을 비교할 수 있습니다. DB 범위는 실행 호스트가 고정합니다. stdio에는 프레임·메시지 빈도·대기 출력 제한이 있습니다. 출력 쓰기가 5초 동안 막히면 시간 제한을 적용하고, CLI가 소유한 작업을 정리한 뒤 네이티브 쓰기로 남아 있는 프로세스를 종료합니다.

## 호스트가 맡는 부분

인증정보, 도구 권한, 애플리케이션 검증, UI와 운영체제 격리는 호스트에서 제공합니다. 함수에 취소 신호를 전달하며, 그 신호를 무시하는 함수는 호스트 환경에서 계속 실행될 수 있습니다. 강제 종료와 CPU·메모리 제한은 별도 워커나 프로세스로 구성합니다. 검증 영수증에는 실제 수행한 검사와 근거가 기록됩니다.

## 검증

```sh
npm ci
npm test
npm run typecheck:consumer
npm audit --omit=dev --audit-level=low
npm pack --dry-run
```

테스트는 다섯 제공자의 루프백 HTTP 스트리밍, 순서가 보장되는 도구 실행, 실제 파일 검증, 취소·재시작, 컨텍스트 인계, 공통 저장소, 저장 실패, 명시적 결과 복구, CLI·MCP와 막힌 출력 처리를 확인합니다. 클라우드 어댑터는 결정적인 프로토콜 모의 응답으로 검증합니다. 설치본은 CommonJS와 ES 모듈 및 엄격한 타입 선언 검사로 확인합니다.

## 라이선스

Loom 소스는 MIT입니다. 의존 모듈 Mimir와 Clotho에는 배포된 비상업·상업 이용 조건이 적용되며, 해당 문서에 명시된 상업 이용에는 별도 상업 라이선스를 요구합니다. 재배포와 상업 배포 방식을 정할 때 동봉한 라이선스 파일과 `THIRD-PARTY-NOTICES`를 확인하세요.
