import { describe, expect, test } from "bun:test"

import { compareIdentity, describeIdentity, fingerprint } from "../infobase/epf-identity"
import { makeModuleContainer, writeContainer } from "../v8pack/container"
import { checkEpf, clientCheckCode, parseClientCheck, parseServerCheck, serverCheckCode } from "./epf-check"

// failures_to_tools.md T1. The identity half is offline; the compile half is
// two toolkit calls, tested here against a scripted toolkit.

function epf(module: string): Buffer {
  return writeContainer([
    { name: "root", content: Buffer.from("{uuid}") },
    { name: "uuid.0", content: makeModuleContainer(Buffer.from(module, "utf8")) },
  ])
}

describe("is the build the build (T1, identity)", () => {
  const template = { label: "шаблон blank-form.epf", fingerprint: fingerprint(epf("Процедура Заготовка() КонецПроцедуры")) }

  test("a file byte-identical to a template is caught", () => {
    const verdict = compareIdentity(fingerprint(epf("Процедура Заготовка() КонецПроцедуры")), [template])
    expect(verdict).toEqual({ sameAs: "шаблон blank-form.epf", how: "bytes" })
    expect(describeIdentity("x.epf", fingerprint(epf("x")), verdict)).toContain("СБОРКИ НЕ БЫЛО")
  })

  test("a changed file is not", () => {
    expect(compareIdentity(fingerprint(epf("Процедура Создать() КонецПроцедуры")), [template])).toEqual({})
  })

  test("the object module is readable from the container", () => {
    expect(fingerprint(epf("Процедура А() КонецПроцедуры")).module).toContain("Процедура А()")
  })
})

describe("the BSL the check sends", () => {
  test("quotes in a path cannot break the literal", () => {
    expect(serverCheckCode('C:\\a"b.epf', "Проверка1")).toContain('"C:\\a""b.epf"')
  })

  // debrief18.md: opened without it, a user with «Защита от опасных действий» on
  // is asked «Разрешить открывать данный файл?» and the check hangs.
  test("attaches from storage with the platform's warnings off", () => {
    const code = serverCheckCode("C:/x.epf", "П")
    expect(code).toContain("Защита.ПредупреждатьОбОпасныхДействиях = Ложь;")
    expect(code).toContain('ВнешниеОбработки.Подключить(Адрес, "П", Ложь, Защита);')
  })

  test("uses no call the toolkit's keyword filter refuses", () => {
    const code = serverCheckCode("C:/x.epf", "П") + clientCheckCode("П", ["Форма"])
    for (const word of ["Удалить(", "Записать(", "Выполнить(", "Вычислить(", "УстановитьПривилегированныйРежим("]) {
      expect(code).not.toContain(word)
    }
  })
})

describe("reading the answers", () => {
  test("server: name, object module, forms", () => {
    // As the toolkit sends it: `data` is itself a JSON-encoded string.
    const text = JSON.stringify({
      success: true,
      data: JSON.stringify('1ccoder-epf|СтрокаСоединения=File="C:\\b";|attached=П1|name=СозданиеШаблона|object=ok|forms=Форма,Настройки'),
    })
    expect(parseServerCheck(text)).toMatchObject({ name: "СозданиеШаблона", object: "ok", forms: ["Форма", "Настройки"] })
  })

  test("client: each form's result", () => {
    const parsed = parseClientCheck("1ccoder-epf-forms|Форма=ok|Настройки={ВнешняяОбработка.П1.Форма.Настройки.Форма(4,71)}: Переменная не определена")
    expect(parsed?.get("Форма")).toBe("ok")
    expect(parsed?.get("Настройки")).toContain("(4,71)")
  })
})

describe("the whole check against a scripted toolkit", () => {
  const profile = { kind: "file" as const, filePath: "C:\\b" }

  function toolkit(server: string, client: string): typeof fetch {
    const replies = [
      { jsonrpc: "2.0", id: 1, result: {} },
      null,
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: server }] } },
      { jsonrpc: "2.0", id: 1, result: {} },
      null,
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: client }] } },
    ]
    let call = 0
    return (async () => {
      const reply = replies[call++]
      return new Response(reply ? JSON.stringify(reply) : null, {
        status: reply ? 200 : 202,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
  }

  test("a form that does not compile fails the check, with its line", async () => {
    const outcome = await checkEpf({ path: "C:/w/x.epf" }, profile, {
      fetch: toolkit(
        '1ccoder-epf|СтрокаСоединения=File="C:\\b";|attached=П1|name=Обр|object=ok|forms=Форма',
        "1ccoder-epf-forms|Форма={ВнешняяОбработка.П1.Форма.Форма.Форма(13,29)}: Переменная не определена",
      ),
    })
    expect(outcome).toMatchObject({ ok: true, passed: false })
    expect(outcome.ok && outcome.text).toContain("(13,29)")
  })

  // debrief13.md §13.12: forms that could not be checked ended the report with
  // «Есть ошибки» under a table showing none.
  test("forms that could not be checked are not reported as errors", async () => {
    const outcome = await checkEpf({ path: "C:/w/x.epf" }, profile, {
      fetch: toolkit(
        '1ccoder-epf|СтрокаСоединения=File="C:\\b";|attached=П1|name=Обр|object=ok|forms=Форма',
        "Неизвестный инструмент: execute_code_client",
      ),
    })
    expect(outcome).toMatchObject({ ok: true, passed: false })
    expect(outcome.ok && outcome.text).not.toContain("Есть ошибки")
    expect(outcome.ok && outcome.text).toContain("проверено не всё: форма «Форма»")
  })

  // 2026-09-25, observed live. This used to assert that a name differing from
  // `expectName` is a failure -- the F7 identity signal from debrief7 §8.4. It
  // passes against a scripted toolkit, where the fixture can return a name
  // unlike the attach name, and it cannot work against the platform: the probe
  // attaches under a generated `Проверка<timestamp>` name, and
  // `Метаданные().Имя` of an attached external processing returns that ATTACH
  // name. So the live check reported «Имя обработки в метаданных:
  // Проверка1790344981201 / ОЖИДАЛОСЬ «НастройкаШаблоновСчета» — это другая
  // обработка» about a correct build, every single time `expect_name` was given.
  //
  // The requirement stands and the mechanism does not: the name inside the file
  // is readable without the platform (`v8pack info`) and that is where it has to
  // come from. Until then the claim is not made, because a check that accuses a
  // good artefact costs more than a check that abstains.
  test("no name accusation is made from the attach name", async () => {
    const outcome = await checkEpf({ path: "C:/w/x.epf", expectName: "СозданиеШаблона" }, profile, {
      fetch: toolkit(
        '1ccoder-epf|СтрокаСоединения=File="C:\\b";|attached=Проверка1|name=Проверка1|object=ok|forms=Форма',
        "1ccoder-epf-forms|Форма=ok",
      ),
    })
    expect(outcome).toMatchObject({ ok: true, passed: true })
    expect(outcome.ok && outcome.text).not.toContain("ОЖИДАЛОСЬ")
    expect(outcome.ok && outcome.text).toContain("имя подключения, а не имя из файла")
    // The agent is told where the real name can be read instead.
    expect(outcome.ok && outcome.text).toContain("v8pack info")
  })

  // 2026-09-25, observed live. The toolkit build serves server-side execution
  // only, so the form half cannot run -- and it said «ответ не распознан», which
  // reads like a transient parsing problem worth retrying. It is a permanent
  // limit, so the message names it and names the only way round it.
  test("a toolkit without client execution says so, instead of looking transient", async () => {
    const outcome = await checkEpf({ path: "C:/w/x.epf" }, profile, {
      fetch: toolkit(
        '1ccoder-epf|СтрокаСоединения=File="C:\\b";|attached=П1|name=П1|object=ok|forms=Форма',
        '{"success": false, "error": "Неизвестный инструмент: execute_code_client"}',
      ),
    })
    const text = outcome.ok ? outcome.text : ""
    expect(text).toContain("нет выполнения кода на клиенте")
    expect(text).toContain("открыть форму в сеансе 1С")
    expect(text).not.toContain("ответ не распознан")
  })

  // The other half of F7 -- byte comparison against the templates and the source
  // file -- lives in epf-identity and still works; it is what reported
  // «Отличается от шаблонов и от исходного файла» on the live run.

  // debrief18.md: a bare «AbortError: This operation was aborted», twice, while a
  // platform dialog held the session.
  test("a timeout names the step and where to look", async () => {
    const aborting = (async () => {
      throw new DOMException("This operation was aborted", "AbortError")
    }) as unknown as typeof fetch
    const outcome = await checkEpf({ path: "C:/w/x.epf" }, profile, { fetch: aborting, timeoutMs: 5_000 })
    expect(outcome).toMatchObject({ ok: false, reason: "failed" })
    const detail = outcome.ok ? "" : (outcome.detail ?? "")
    expect(detail).toContain("не ответил за 5 с (серверная часть")
    expect(detail).toContain("1c_processes")
  })

  test("another infobase on the port is refused, not checked", async () => {
    const outcome = await checkEpf({ path: "C:/w/x.epf" }, profile, {
      fetch: toolkit('1ccoder-epf|СтрокаСоединения=File="D:\\other";|attached=П1|name=Обр|object=ok|forms=', ""),
    })
    expect(outcome).toMatchObject({ ok: false, reason: "other-infobase" })
  })
})
