# ticker — Ujwal

What is owed today on money lent, tracked from a single committed ledger with no backend.

This is a published copy: the app plus one ledger, `data.json`. It is generated from a
private repo by `publish-ujwal.sh`, so edit the ledger there rather than here, or the two
will disagree.

The balance accrues daily at the home loan rate and compounds monthly, because money that
did not go into a home loan as a part prepayment costs the loan rate, compounded — a fixed
EMI turns interest not saved into slower principal reduction.

```sh
node --test          # the interest maths
node validate.mjs    # check data.json
node server.mjs      # then open http://localhost:8000
```
