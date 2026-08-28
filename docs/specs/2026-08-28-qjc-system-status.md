# QJC System Status 기능 명세

## Problem

macOS에서 CPU, 메모리, 디스크 사용량을 확인하려면 Activity Monitor를 열어야 하므로 현재 PC 상태를 즉시 파악하기 어렵습니다.

## Goal

메뉴바에서 세 지표의 현재 사용률을 한눈에 보고, 클릭하면 용량과 상태 설명을 확인할 수 있는 QJC 스타일의 네이티브 macOS 앱을 제공합니다.

## Non-goals

- 프로세스별 사용량, 네트워크 속도, 온도, 팬 제어는 포함하지 않습니다.
- 원격 전송, 계정, 분석 수집, 서버 연결은 포함하지 않습니다.
- 자동 실행 설정은 이번 버전에 포함하지 않습니다.

## Requirements

1. 메뉴바에 CPU, RAM, SSD 사용률을 2초 간격으로 표시합니다.
2. 클릭 시 CPU·메모리·디스크 카드, 실제 사용/전체 용량, 상태 문구를 표시합니다.
3. 수치가 높아지면 색상과 상태 문구로 주의도를 구분합니다.
4. QJC 공식 V07 로고와 `#EC6C9C`, `#213F95`, `#1A1E3C` 팔레트를 사용합니다.
5. 디스크 정보를 읽지 못해도 크래시하지 않고 사용 불가 상태를 표시합니다.
6. 외부 전송 없이 로컬 시스템 API만 사용합니다.

## Acceptance criteria

- `swift run -- --self-test`가 통과하며 비율 보정, 상태 문구, 용량 포맷, 디스크 실패 fallback을 검증합니다. (현재 Swift 런타임에 XCTest/Testing 모듈이 없어 앱 내 assertion seam을 사용합니다.)
- `swift build -c release`가 성공하고 `dist/QJC System Status.app`을 생성합니다.
- 실제 앱 팝오버에 CPU·RAM·SSD 세 지표와 마지막 업데이트 시간이 표시됩니다.
- 앱은 Dock 아이콘 없이 메뉴바에서 실행되며 종료 버튼으로 종료할 수 있습니다.

## Risks

- CPU는 연속 tick 차이로 계산하므로 첫 샘플은 0으로 시작할 수 있습니다.
- 메뉴바 공간이 좁으면 macOS가 일부 항목을 숨길 수 있으므로 짧은 라벨을 사용합니다.

## Verification

- `swift run QJCSystemStatus --self-test` PASS: metric clamps, thresholds, byte formatting, disk fallback, 8개 지원 언어 문구, locale 감지.
- `swift run QJCSystemStatus --dump-ui-text --locale=fr` PASS: 프랑스어 headline·CPU/RAM/DISK 문구 출력.
- `swift run QJCSystemStatus --dump-ui-text --locale=ko_KR` PASS: 한국어 headline·CPU/RAM/DISK 문구 출력.
- `swift build -c release` PASS 및 `dist/QJC System Status.app` 생성.
- Computer Use/AppleScript 메뉴바 클릭 PASS: `README-screenshot.png`에서 CPU 75%, RAM 82%, DISK 99%, 마지막 업데이트가 확인됨. 개인정보가 포함된 전체 데스크톱 캡처는 저장하지 않았습니다.
