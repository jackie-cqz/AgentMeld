# Financial Document Processor

Process every JPG and PDF in `documents/`:

1. Move invoices to `invoices/` and all other documents to `other/`.
2. For invoices, extract `total_amount` and `vat_amount`.
3. If both Total and Amount Due exist, use Total.
4. Use `0` when VAT/Tax/GST is absent.
5. Write `invoices/summary.csv` with `filename,total_amount,vat_amount` and a final `total` row.
6. Leave `documents/` empty.

