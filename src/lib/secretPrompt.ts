/** A local, masked input modal for high-risk secrets (never persisted by this module). */
export interface SecretPromptOptions {
  title: string;
  detail: string;
  confirm?: boolean;
  minLength?: number;
}

export function promptForSecret(options: SecretPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "rounded-xl border border-gray-200 bg-white p-6 text-gray-900 shadow-2xl backdrop:bg-black/50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 w-[min(92vw,28rem)]";
    const form = document.createElement("form");
    form.className = "flex flex-col gap-3";
    form.noValidate = true;
    const heading = document.createElement("h2");
    heading.className = "text-lg font-semibold";
    heading.textContent = options.title;
    const detail = document.createElement("p");
    detail.className = "text-sm text-gray-600 dark:text-gray-300";
    detail.textContent = options.detail;
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.required = true;
    input.placeholder = "Password / 口令";
    input.className = "rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm dark:border-gray-600";
    input.setAttribute("aria-label", "Secret password");
    form.append(heading, detail, input);
    let again: HTMLInputElement | null = null;
    if (options.confirm) {
      again = input.cloneNode(true) as HTMLInputElement;
      again.placeholder = "Confirm password / 再次输入口令";
      again.setAttribute("aria-label", "Confirm secret password");
      form.append(again);
    }
    const error = document.createElement("p");
    error.className = "text-sm text-red-600 dark:text-red-400";
    error.setAttribute("role", "alert");
    form.append(error);
    const footer = document.createElement("div");
    footer.className = "mt-2 flex justify-end gap-3";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "取消 / Cancel";
    cancelButton.className = "rounded-lg border px-4 py-2 text-sm dark:border-gray-600";
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.textContent = "确认 / OK";
    submitButton.className = "rounded-lg bg-gray-900 px-4 py-2 text-sm text-white dark:bg-gray-100 dark:text-gray-900";
    footer.append(cancelButton, submitButton);
    form.append(footer);
    dialog.append(form);
    let finished = false;
    function finish(value: string | null) {
      if (finished) return;
      finished = true;
      input.value = "";
      if (again) again.value = "";
      dialog.close();
      dialog.remove();
      resolve(value);
    }
    cancelButton.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value;
      if (value.length < (options.minLength ?? 12)) {
        error.textContent = `Please enter at least ${options.minLength ?? 12} characters / 口令长度不足`;
        return;
      }
      if (again && again.value !== value) {
        error.textContent = "Passwords differ / 两次输入的口令不一致";
        return;
      }
      finish(value);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
  });
}
