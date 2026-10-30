import { Money } from "@filspay/ui";

export function CheckoutSummary({ merchantDisplayName, amountFils }: { merchantDisplayName: string; amountFils: number }) {
  return (
    <>
      <p className="checkout-merchant">{merchantDisplayName}</p>
      <div className="checkout-amount"><Money fils={amountFils} size="hero" /></div>
    </>
  );
}
