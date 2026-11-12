# 가족 계정 서버 설정 안내

카카오·네이버 로그인과 기기 간 기록 동기화를 켜는 방법입니다. 모두 무료 요금제로 됩니다.
비밀값(키, 시크릿)은 이 파일이나 코드에 적지 말고, GitHub 저장소의 Secrets에만 넣어 주세요.

아래에서 `<서버주소>`는 `https://pip-family-api.<내 workers 하위도메인>.workers.dev` 입니다.

## 1. Cloudflare (서버와 데이터베이스)
1. https://dash.cloudflare.com 에서 무료 가입
2. **Workers & Pages** 메뉴에 한 번 들어가 workers.dev 하위도메인을 정합니다 → `<서버주소>`가 정해져요
3. **Storage & Databases → D1 → Create**: 이름 `pip-family-db` → 만든 뒤 **Database ID** 복사
4. **My Profile → API Tokens → Create Token** → "Edit Cloudflare Workers" 템플릿에 **D1 편집 권한**을 추가해 생성 → 토큰 복사
5. 대시보드 오른쪽의 **Account ID** 복사

## 2. 카카오 (developers.kakao.com)
1. 내 애플리케이션 → 애플리케이션 추가
2. 앱 키에서 **REST API 키** 복사
3. 카카오 로그인 → **활성화 ON**, Redirect URI에 `<서버주소>/auth/kakao/callback` 등록
4. 카카오 로그인 → 보안 → **Client Secret 생성, 활성화** → 코드 복사
5. 동의항목: 이메일·프로필 사진 등은 받지 않습니다. 필수 항목이 꼭 하나 필요하면 닉네임만 두세요. (서버는 회원번호 외에는 읽거나 저장하지 않습니다)

## 3. 네이버 (developers.naver.com)
1. Application → 애플리케이션 등록, 사용 API: **네이버 로그인**
2. 제공 정보는 최소로 선택 (서버는 회원 식별값 외에는 읽거나 저장하지 않습니다)
3. 서비스 환경 **PC웹, 모바일웹**: 서비스 URL `https://bsjunhyuk.github.io`, Callback URL `<서버주소>/auth/naver/callback`
4. **Client ID, Client Secret** 복사
5. 검수 없이 '개발 중' 상태로 씁니다 → **멤버관리 → 테스트 ID**에 아빠·엄마 네이버 아이디 등록

## 4. GitHub 저장소에 값 넣기
저장소 **Settings → Secrets and variables → Actions**

Secrets (New repository secret):
| 이름 | 값 |
|---|---|
| CLOUDFLARE_API_TOKEN | 1-4의 토큰 |
| CLOUDFLARE_ACCOUNT_ID | 1-5의 Account ID |
| KAKAO_REST_KEY | 2-2 |
| KAKAO_CLIENT_SECRET | 2-4 |
| NAVER_CLIENT_ID | 3-4 |
| NAVER_CLIENT_SECRET | 3-4 |
| SESSION_SECRET | 40자 이상의 무작위 문자열 (비밀번호 생성기로 만들기). **한 번 정하면 바꾸지 마세요** — 바꾸면 모든 로그인이 풀리고 가족 연결을 다시 해야 해요 |

Variables 탭 (New repository variable):
| 이름 | 값 |
|---|---|
| D1_DATABASE_ID | 1-3의 Database ID |

## 5. 배포
**Actions → Deploy family account server → Run workflow**.
끝나면 `<서버주소>/health` 에 `{"ok":true}`가 보여요. 이 주소를 앱의 `API_BASE`에 넣으면 로그인 버튼이 켜집니다.

## 서버가 저장하는 것과 하지 않는 것
- 저장: 회원 식별값(서버 비밀키로 변환한 값), 가족 번호·초대 코드, 역할별 학습 기록(난이도, 날짜별 사용 시간, 별점, 연습 횟수), 보호자 동의 일시
- 저장 안 함: 이름, 이메일, 닉네임, 프로필 사진, 전화번호, 음성, 말한 문장, 접속 IP
- 삭제: 앱에서 '가족 계정과 기록 모두 삭제' 시 즉시, 3개월 동안 아무도 쓰지 않으면 매일 새벽 자동 삭제
