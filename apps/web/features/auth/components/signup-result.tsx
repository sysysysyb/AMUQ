import { ButtonLink } from "@web/components/ui/button";
import { Feedback } from "@web/components/ui/feedback";
import { Heading } from "@web/features/auth/components/auth-form";
import { AuthShell } from "@web/features/auth/components/auth-shell";
import { type SignupOutcome } from "@web/features/auth/lib/use-signup-flow";

export const SignupResult = ({ outcome }: { outcome: SignupOutcome }) => (
  <AuthShell>
    <Heading>
      {outcome === "created"
        ? "회원가입이 완료되었습니다!"
        : outcome === "account_exists"
          ? "이미 가입된 이메일이에요"
          : "이미 가입 처리된 요청이에요"}
    </Heading>
    <Feedback tone={outcome === "created" ? "success" : "info"}>
      {outcome === "created"
        ? "이제 계정을 사용할 수 있어요!"
        : outcome === "verification_completed"
          ? "이 인증 요청의 가입은 이미 처리됐어요. 등록한 계정으로 로그인해 주세요."
          : outcome === "already_completed"
            ? "다시 입력한 비밀번호는 적용되지 않았어요. 처음 등록한 비밀번호로 로그인해 주세요."
            : "기존 계정으로 로그인하거나 비밀번호를 재설정해 주세요."}
    </Feedback>
    <ButtonLink href="/login">로그인하러 가기</ButtonLink>
    {outcome === "account_exists" && (
      <ButtonLink variant="secondary" href="/forgot-password">
        비밀번호 재설정
      </ButtonLink>
    )}
  </AuthShell>
);
