"use strict";

const retailCsv = (() => {
  const maxUploadBytes = 10 * 1024 * 1024;

  function* rows(csv) {
    const text = csv.replace(/^\uFEFF/u, "");
    let fields = [];
    let field = "";
    let state = "start";
    let line = 1;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      const next = text[index + 1];
      if (state === "quoted") {
        if (character === '"') {
          if (next === '"') {
            field += character;
            index++;
          } else {
            state = "closed";
          }
        } else {
          field += character;
          if (character === "\n" || (character === "\r" && next !== "\n")) line++;
        }
        continue;
      }
      if (character === '"' && state === "start") {
        state = "quoted";
        continue;
      }
      if (character === ",") {
        fields.push(field);
      } else if (character === "\r" || character === "\n") {
        if (fields.length || state !== "start") yield { fields: [...fields, field], line };
        fields = [];
        if (character === "\r" && next === "\n") index++;
        line++;
      } else {
        if (state === "closed") throw new Error(`CSV line ${line}: expected a comma after the closing quote.`);
        state = "bare";
        field += character;
        continue;
      }
      field = "";
      state = "start";
    }
    if (state === "quoted") throw new Error(`CSV line ${line}: closing quote is missing.`);
    if (fields.length || state !== "start") yield { fields: [...fields, field], line };
  }

  async function readFile(file) {
    if (file.size < 1 || file.size > maxUploadBytes) throw new Error("Choose a nonempty CSV file up to 10 MiB.");
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      throw new Error("Couldn't read the CSV. Choose the file again.");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Save the CSV as UTF-8 and try again.");
    }
  }

  function textCell(value) {
    const formulaLike = /^[=+@＝＋－＠-]/u.test(value.trimStart()) || /^[\t\r\n]/u.test(value);
    const text = formulaLike ? "'" + value : value;
    return '"' + text.replaceAll('"', '""') + '"';
  }

  function download(filename, lines) {
    const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return { rows, readFile, textCell, download };
})();
