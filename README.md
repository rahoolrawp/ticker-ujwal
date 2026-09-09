# ticker

What is owed today on money lent, tracked from a single committed ledger with no backend.

This is a published copy: the app plus one ledger, `data.json`. It is generated from a
private repo by `publish.sh`, so edit the ledger there rather than here, or the two will
disagree.

The balance accrues daily at the home loan rate and compounds monthly, because money that
did not go into a home loan as a part prepayment costs the loan rate, compounded - a fixed
EMI turns interest not saved into slower principal reduction.

```sh
npm test          # the interest maths
npm run validate  # check data.json
npm start         # then open http://localhost:8000
```
