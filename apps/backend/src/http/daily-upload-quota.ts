import {
	DailyUploadQuotaExceededError,
	formatDailyUploadQuotaMessage,
} from "../services/daily-upload-quota";
import { createApiError } from "./api-error";

// Lets a transaction's quota failure surface as a value the route can answer with.
export const catchDailyQuotaExceeded = (error: unknown) => {
	if (error instanceof DailyUploadQuotaExceededError) {
		return error;
	}
	throw error;
};

export const createDailyQuotaExceededError = (
	requestId: string | null | undefined,
	error: DailyUploadQuotaExceededError,
) =>
	createApiError(
		requestId,
		"DAILY_UPLOAD_LIMIT_EXCEEDED",
		formatDailyUploadQuotaMessage(error.quota),
		429,
	);
