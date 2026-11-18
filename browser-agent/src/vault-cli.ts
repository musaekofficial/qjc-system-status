// 금고 관리 명령. 맥미니 터미널에서만 실행한다(채팅으로는 비밀번호를 받지 않는다).
//   npm run vault -- add --label "네이버 회사 계정" --origin https://nid.naver.com --user myid [--scope shared|someone@gmail.com]
//   npm run vault -- list
//   npm run vault -- remove cred_ab12cd
import { parseArgs } from "node:util";
import { addEntry, listAll, removeEntry } from "./vault.ts";

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("run this in a terminal so the password is typed, not piped"));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: "string" },
    origin: { type: "string" },
    user: { type: "string" },
    scope: { type: "string", default: "shared" },
  },
});

const [command, arg] = positionals;

if (command === "add") {
  if (!values.label || !values.origin || !values.user) {
    console.error('usage: npm run vault -- add --label "이름" --origin https://로그인페이지주소 --user 아이디 [--scope shared|로그인]');
    process.exit(1);
  }
  const password = await askHidden("비밀번호 (화면에 표시되지 않음): ");
  const entry = addEntry({ label: values.label, origin: values.origin, username: values.user, password, scope: values.scope!.toLowerCase() });
  console.log(`저장함: ${entry.id} ${entry.label} (${entry.origin}, 범위: ${entry.scope})`);
} else if (command === "list") {
  for (const e of listAll()) console.log(`${e.id}\t${e.label}\t${e.origin}\t${e.username}\t${e.scope}`);
} else if (command === "remove" && arg) {
  console.log(removeEntry(arg) ? `삭제함: ${arg}` : `없음: ${arg}`);
} else {
  console.error("commands: add | list | remove <id>");
  process.exit(1);
}
