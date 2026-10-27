"use client";

import { useState } from "react";

export const useErrorFeedback = (initialError?: string | undefined) => {
  const [error, setError] = useState(initialError);
  const [errorVersion, setErrorVersion] = useState(0);

  const showError = (message: string) => {
    setError(message);
    setErrorVersion((version) => version + 1);
  };

  const clearError = () => setError(undefined);

  return { error, errorVersion, showError, clearError };
};
