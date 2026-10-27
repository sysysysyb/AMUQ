export interface ApiError {
  code?: string;
  message?: string;
}

export const readApiError = async (response: Response): Promise<ApiError> => {
  try {
    return (await response.json()) as ApiError;
  } catch {
    return {};
  }
};

export const responseError = async (response: Response) => {
  const body = await readApiError(response);
  return body.message ?? "요청을 처리하지 못했습니다. 다시 시도해주세요.";
};

export const loginErrorMessage = (code?: string) => {
  if (code === "provider_cancelled") return "Google 로그인이 취소됐습니다.";
  if (code === "identity_conflict")
    return "처음 로그인한 Google 계정으로 다시 시도해주세요.";
  if (code === "service_error")
    return "로그인 서비스를 잠시 사용할 수 없습니다.";
  return code ? "Google 로그인 중 오류가 발생했습니다." : undefined;
};
