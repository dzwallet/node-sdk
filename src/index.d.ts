export interface Config { mode?: 'test' | 'live'; publicKey: string; secretKey?: string; baseUrl?: string; timeoutMs?: number; statusRetries?: number; fetch?: typeof fetch; }
export interface Customer { first_name: string; last_name: string; email: string; mobile: string; }
export interface InitiateParams {
  identifier: string; amount: number | string; details: string; ipn_url: string; success_url: string; cancel_url: string; site_name: string;
  customer: Customer; currency?: 'DZD'; gateway_methods?: string[]; site_logo?: string; checkout_theme?: 'light' | 'dark';
  shipping_info?: Record<string, string>; billing_info?: Record<string, string>;
}
export interface PaymentInitiated { redirectUrl: string; identifier: string; raw: any; }
export interface PaymentStatus { status: 'initiated' | 'pending' | 'success' | 'rejected' | 'cancelled' | string; identifier: string; amount: string | null; currency: string | null; trx: string | null; isPaid: boolean; isFinal: boolean; raw: any; }
export interface PaymentLink { trx: string; amount: string; currency: string; status: string; url: string; printUrl: string | null; expiresAt: string | null; reference: string | null; identifier: string | null; emailSent: boolean | null; isOpen: boolean; raw: any; }
export interface LinkOptions { note?: string; days?: number; reference?: string; ipn_url?: string; email?: string; }
export interface Ipn { status: string; identifier: string; amount: string; trx: string | null; isSuccess: boolean; data: Record<string, any>; raw: any; }

export class DzWallet {
  constructor(config: Config);
  initiatePayment(params: InitiateParams): Promise<PaymentInitiated>;
  paymentStatus(identifier: string): Promise<PaymentStatus>;
  createPaymentLink(amount: number | string, options?: LinkOptions): Promise<PaymentLink>;
  paymentLink(reference: string): Promise<PaymentLink>;
  reactivatePaymentLink(reference: string): Promise<PaymentLink>;
  signature(amount: string | number, identifier: string): string;
  verifyWebhook(rawBody: string | Buffer, signatureHeader: string | undefined, options?: { tolerance?: number; now?: number; eventIdHeader?: string }): { timestamp: number; eventId: string | null };
  verifyNotification(rawBody: string | Buffer, headers?: Record<string, string | string[] | undefined>, options?: { tolerance?: number; now?: number; requireV2?: boolean }): { ipn: Ipn; eventId: string | null };
  verifyIpn(body: any, expectedIdentifier?: string | null, expectedAmount?: number | string | null): Ipn;
  static newIdentifier(prefix?: string): string;
}
export function parseIpnForm(raw: string): any;
export class DzWalletError extends Error {}
export class ConfigurationError extends DzWalletError {}
export class ConnectionError extends DzWalletError {}
export class InvalidSignatureError extends DzWalletError {}
export class ApiError extends DzWalletError { errors: string[]; httpStatus: number | null; readonly isRateLimited: boolean; }
