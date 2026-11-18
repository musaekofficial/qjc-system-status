// 결정 둘: 사람이 채팅에 보낸 카드번호·비밀번호는 저장 전에 가리고, 에이전트에게 넘기지 않는다.

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const RRN = /\b\d{6}[- ]?[1-4]\d{6}\b/g; // 주민등록번호
// 라벨 앞은 글자가 아니어야 하고("shopping"의 pin 방지), 라벨 뒤에는 구분자(: = 은/는/이/가 또는 공백)가 있어야 한다.
const SECRET_LABEL =
  /(?<![\p{L}\p{N}])(비밀\s?번호|비번|패스워드|암호|password|passwd|pwd|pw|pin|cvc|cvv|보안\s?코드|인증\s?번호|otp)(\s*(?:[:=]|=>)\s*|\s*(?:은|는|이|가)\s+|\s+)(["'“”]?)([^\s"'“”,]{3,})/giu;

export interface Redacted {
  text: string;
  redacted: string[]; // 무엇을 가렸는지 (값은 없음)
}

export function redact(input: string): Redacted {
  const redacted: string[] = [];
  let text = input.replace(CARD, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      redacted.push("카드번호");
      return "[카드번호 가림]";
    }
    return match;
  });
  text = text.replace(RRN, () => {
    redacted.push("주민등록번호");
    return "[주민등록번호 가림]";
  });
  text = text.replace(SECRET_LABEL, (_m, label: string, sep: string, quote: string) => {
    redacted.push(label);
    return `${label}${sep}${quote}[가림]`;
  });
  return { text, redacted };
}
