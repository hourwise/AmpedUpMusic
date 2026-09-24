/**
 * Static SumUp fixtures for AMPED-07A (test-only).
 *
 * Shapes follow the official Checkouts API reference (reviewed 2026-09-24).
 * All identifiers are obviously fake; none of these values is a credential.
 */

export const FAKE_API_KEY = 'sup_sk_test_not-a-real-key-000000000000';
export const FAKE_MERCHANT_CODE = 'MCTEST01';
export const FAKE_CHECKOUT_ID = '4e425463-3e1b-431d-83fa-1e51c2925e99';
export const FAKE_HOSTED_URL = 'https://checkout.sumup.com/pay/8f9316a3-cda9-42a9-9771-54d534315676';
export const FAKE_VALID_UNTIL = '2026-09-24T13:00:00.000Z';
export const FAKE_PAID_AT = '2026-09-24T12:34:56.876Z';

/** POST /v0.1/checkouts - pending hosted checkout, plus an unknown future field. */
export const CREATE_PENDING = {
  id: FAKE_CHECKOUT_ID,
  status: 'PENDING',
  checkout_reference: 'AMP-26-00001',
  amount: 10,
  currency: 'GBP',
  merchant_code: FAKE_MERCHANT_CODE,
  hosted_checkout_url: FAKE_HOSTED_URL,
  valid_until: FAKE_VALID_UNTIL,
  date: '2026-09-24T12:30:00+00:00',
  transactions: [],
  some_future_field: { added: 'later' },
};

/** A creation response where SumUp omitted the nullable valid_until. */
export const CREATE_PENDING_NO_VALID_UNTIL = {
  id: FAKE_CHECKOUT_ID,
  status: 'PENDING',
  hosted_checkout_url: FAKE_HOSTED_URL,
};

/** GET /v0.1/checkouts/{id} fixtures. */
export const GET_PENDING = { id: FAKE_CHECKOUT_ID, status: 'PENDING', transactions: [] };

export const GET_PAID = {
  id: FAKE_CHECKOUT_ID,
  status: 'PAID',
  transactions: [
    { id: 'txn-1', status: 'PENDING', timestamp: '2026-09-24T12:33:00.000Z' },
    { id: 'txn-2', status: 'SUCCESSFUL', timestamp: FAKE_PAID_AT, transaction_code: 'TEENSK4W2K' },
  ],
};

export const GET_FAILED = { id: FAKE_CHECKOUT_ID, status: 'FAILED', transactions: [] };
export const GET_EXPIRED = { id: FAKE_CHECKOUT_ID, status: 'EXPIRED', transactions: [] };

export const GET_UNKNOWN_STATUS = { id: FAKE_CHECKOUT_ID, status: 'SOMETHING_NEW', transactions: [] };
export const GET_MISSING_STATUS = { id: FAKE_CHECKOUT_ID, transactions: [] };
export const GET_STATUS_NOT_STRING = { id: FAKE_CHECKOUT_ID, status: 42 };

export const CREATE_MISSING_ID = { status: 'PENDING', hosted_checkout_url: FAKE_HOSTED_URL };
export const CREATE_MISSING_URL = { id: FAKE_CHECKOUT_ID, status: 'PENDING' };
export const CREATE_BAD_URL_TYPE = {
  id: FAKE_CHECKOUT_ID,
  status: 'PENDING',
  hosted_checkout_url: 12345,
};

export const BAD_JSON = '{ "id": "not closed"';

/** Error bodies as documented for 400/401/403/409. */
export const ERROR_400 = { message: 'Validation error', error_code: 'MISSING', param: 'merchant_code' };
export const ERROR_401 = {
  detail: 'Unauthorized.',
  status: 401,
  title: 'Unauthorized',
  trace_id: 'not-a-real-trace-id',
};
export const ERROR_404 = {
  type: 'https://developer.sumup.com/problem/not-found',
  title: "Requested resource couldn't be found.",
  status: 404,
};
export const ERROR_409 = {
  error_code: 'DUPLICATED_CHECKOUT',
  message: 'Checkout with this checkout reference and pay to email already exists',
};
export const ERROR_429 = { message: 'Too many requests' };
export const ERROR_500 = { message: 'Internal server error' };
