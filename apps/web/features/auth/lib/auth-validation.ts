// Match the API's ajv-formats full email format.
const AUTH_EMAIL_FORMAT =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

export const authFieldErrorMessage = (
  input: HTMLInputElement,
  type = input.type,
) => {
  if (input.validity.valueMissing) return "필수 입력 항목입니다.";
  const length = Array.from(input.value).length;
  if (type === "email") {
    if (input.validity.typeMismatch || !AUTH_EMAIL_FORMAT.test(input.value)) {
      return "이메일 형식으로 입력해주세요.";
    }
    if (length > 254) return "이메일은 254자 이하로 입력해주세요.";
  }
  if (
    input.name !== "password" ||
    type !== "password" ||
    input.autocomplete !== "new-password"
  )
    return undefined;
  if (
    length < 12 ||
    length > 20 ||
    !/[A-Z]/.test(input.value) ||
    !/[a-z]/.test(input.value) ||
    !/[0-9]/.test(input.value)
  ) {
    return "비밀번호는 12~20자로, 영문 대문자와 소문자 및 숫자를 포함해주세요.";
  }
  return undefined;
};
