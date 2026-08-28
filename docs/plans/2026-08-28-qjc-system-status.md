# QJC System Status 실행 계획

1. Swift Package와 테스트 대상을 만들고 미구현 심볼로 RED를 확인했습니다. (현재 런타임의 XCTest/Testing 부재로 앱 `--self-test` seam으로 전환)
2. 시스템 수집 모델과 CPU·메모리·디스크 수집기를 구현해 `swift run QJCSystemStatus --self-test` GREEN을 확인했습니다.
3. SwiftUI `MenuBarExtra`와 QJC 브랜드 팝오버를 구현했습니다.
4. 공식 V07 로고 리소스와 앱 번들 패키징 스크립트를 추가했습니다.
5. `swift build -c release`와 앱 번들 생성 결과를 검증합니다.
6. 실제 앱을 실행하고 macOS UI에서 메뉴 팝오버를 열어 화면 증거를 캡처합니다.
7. 독립 적대 검토를 통과한 뒤 최종 검증 결과를 명세에 기록합니다.
