import { ButtonLink } from "@web/components/ui/button";
import { Feedback } from "@web/components/ui/feedback";
import { Heading } from "@web/features/auth/components/auth-form";
import { AuthShell } from "@web/features/auth/components/auth-shell";

export const VerifyEmailScreen = () => (
  <AuthShell>
    <Heading>이메일 인증을 다시 진행해 주세요</Heading>
    <Feedback>
      가입 방식이 변경되어 이전 인증 링크는 사용할 수 없어요. 가입 화면에서
      인증번호를 받아주세요.
    </Feedback>
    <ButtonLink href="/signup">이메일 인증 다시 시작</ButtonLink>
    <ButtonLink variant="secondary" href="/login">
      로그인으로 이동
    </ButtonLink>
  </AuthShell>
);
