using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Family Hub F5 — household FINANCE from a Rocket Money CSV import (/api/family/finance). Finance is the
/// extra-sensitive corner of the hub: every route requires BOTH family.use AND family.finance, so a caller
/// holding only family.use is 403 on every finance route. Covers: importing a small Rocket-Money-format CSV
/// (two SoFi banks + a Mission Lane + a USAA credit card, with mixed expense/income/transfer rows, a
/// quoted-comma merchant, and a parenthesized-negative amount) creates one account per distinct
/// (AccountName, Institution) and transactions with the correct Kind classification; RE-importing the same
/// CSV imports 0 (everything deduped); relabeling an account owner sticks and flows into /summary byOwner;
/// /summary computes byCategory/byAccount/byOwner and EXCLUDES transfers from spending; cross-household
/// isolation; and NO email anywhere on the wire (importer + people are userId+name only).
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyFinanceTests(WebAppFactory factory)
{
    private HttpClient Admin()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail));
        return c;
    }

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private async Task<(string email, HttpClient client, int id)> ProvisionUser(params string[] permissions)
    {
        var email = $"famfin-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static bool HasProperty(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);

    /// <summary>
    /// A small Rocket-Money-format export across the family's four real accounts:
    /// two SoFi bank accounts (his + hers), a Mission Lane credit card, and a USAA credit card.
    /// Includes a quoted merchant containing a comma, a parenthesized-negative amount, an income paycheck,
    /// a bank-deposit credit with no category, a transfer, and a credit-card payment.
    /// </summary>
    private const string SampleCsv =
        "Date,Original Date,Account Type,Account Name,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible\n" +
        // SoFi #1 (his) — an expense (negative), a paycheck (income), and a transfer out.
        "2026-05-03,2026-05-03,Checking,SoFi Checking 1,SoFi,Trader Joes,,-54.20,TJ groceries,Groceries,,,\n" +
        "2026-05-01,2026-05-01,Checking,SoFi Checking 1,SoFi,ACME Payroll,,2500.00,Payroll,Paycheck,,,\n" +
        "2026-05-10,2026-05-10,Checking,SoFi Checking 1,SoFi,Move to savings,,-300.00,xfer,Transfer,,,\n" +
        // SoFi #2 (hers) — an expense, and a bank deposit credit with NO category (=> income).
        "2026-05-04,2026-05-04,Savings,SoFi Savings 2,SoFi,\"Amazon.com, Inc\",,-120.99,online order,Shopping,,,\n" +
        "2026-05-06,2026-05-06,Savings,SoFi Savings 2,SoFi,Deposit,,75.00,random deposit,,,,\n" +
        // Mission Lane credit card — an expense and a parenthesized-negative (also expense), plus a payment (transfer).
        "2026-05-07,2026-05-07,Credit Card,Mission Lane Card,Mission Lane,Shell Gas,,(45.67),fuel,Gas,,,\n" +
        "2026-05-08,2026-05-08,Credit Card,Mission Lane Card,Mission Lane,Payment Thank You,,200.00,cc payment,Credit Card Payment,,,\n" +
        // USAA credit card — a dining expense with a custom name override.
        "2026-05-09,2026-05-09,Credit Card,USAA Card,USAA,SomePOS,Chipotle,-12.50,lunch,Dining,,,\n";

    private async Task<HttpClient> FinanceUser()
    {
        var (_, client, _) = await ProvisionUser("family.use", "family.finance");
        await client.GetAsync("/api/family/household"); // provision the household
        return client;
    }

    private static JsonElement Account(JsonElement accounts, string name) =>
        accounts.EnumerateArray().Single(a => a.GetProperty("name").GetString() == name);

    // =====================================================================================
    // GATING — family.finance is required on EVERY route (family.use alone is not enough)
    // =====================================================================================

    [Fact]
    public async Task Every_finance_route_requires_family_finance_on_top_of_family_use()
    {
        // A user with family.use but WITHOUT family.finance is 403 on every finance route.
        var (_, useOnly, _) = await ProvisionUser("family.use");
        await useOnly.GetAsync("/api/family/household"); // they can use the hub, just not finance

        (await useOnly.PostAsJsonAsync("/api/family/finance/import", new { fileName = "x.csv", content = SampleCsv }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/accounts")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.PutAsJsonAsync("/api/family/finance/accounts/1", new { owner = "his" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/transactions?month=2026-05"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/summary?month=2026-05"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/imports")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        // The AI "explain this month" route is gated the SAME way (family.use alone is not enough).
        (await useOnly.GetAsync("/api/family/finance/ai/summary?month=2026-05"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        // The AI "money coach" route is gated the SAME way (BOTH family.use AND family.finance).
        (await useOnly.GetAsync("/api/family/finance/ai/money-coach"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Finance_routes_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/finance/accounts")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/finance/summary")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/finance/ai/summary")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/finance/ai/money-coach")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // IMPORT — accounts per distinct (name, institution); correct Kind classification; no email
    // =====================================================================================

    [Fact]
    public async Task Import_creates_one_account_per_distinct_name_institution_with_correct_kinds()
    {
        var owner = await FinanceUser();

        var res = await owner.PostAsJsonAsync("/api/family/finance/import",
            new { fileName = "rocketmoney.csv", content = SampleCsv });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await Json(res);

        result.GetProperty("rowCount").GetInt32().Should().Be(8);   // 8 data rows
        result.GetProperty("imported").GetInt32().Should().Be(8);   // all 8 imported first time
        result.GetProperty("skipped").GetInt32().Should().Be(0);
        result.GetProperty("importId").GetInt64().Should().BeGreaterThan(0);
        result.GetRawText().Should().NotContain("@");

        // Four distinct accounts, each starting unassigned, with the right kind from Account Type.
        var accounts = result.GetProperty("accounts");
        accounts.GetArrayLength().Should().Be(4);
        Account(accounts, "SoFi Checking 1").GetProperty("kind").GetString().Should().Be("bank");
        Account(accounts, "SoFi Savings 2").GetProperty("kind").GetString().Should().Be("bank");
        Account(accounts, "Mission Lane Card").GetProperty("kind").GetString().Should().Be("credit");
        Account(accounts, "USAA Card").GetProperty("kind").GetString().Should().Be("credit");
        foreach (var a in accounts.EnumerateArray())
            a.GetProperty("owner").GetString().Should().Be("unassigned"); // importer never guesses whose it is
        Account(accounts, "SoFi Checking 1").GetProperty("institution").GetString().Should().Be("SoFi");

        // GET /accounts reports per-account txn counts + total EXPENSE magnitude.
        var listed = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var sofi1 = Account(listed, "SoFi Checking 1");
        sofi1.GetProperty("txnCount").GetInt32().Should().Be(3); // expense + paycheck + transfer
        sofi1.GetProperty("totalSpentMagnitude").GetDecimal().Should().Be(54.20m); // expense only

        var usaa = Account(listed, "USAA Card");
        usaa.GetProperty("txnCount").GetInt32().Should().Be(1);
        usaa.GetProperty("totalSpentMagnitude").GetDecimal().Should().Be(12.50m);
        listed.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Import_classifies_kind_and_parses_quoted_and_parenthesized_amounts()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        // All May transactions, with their classified Kind.
        var page = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        var items = page.GetProperty("items").EnumerateArray().ToList();
        page.GetProperty("total").GetInt32().Should().Be(8);

        JsonElement ByMerchant(string m) => items.Single(t => t.GetProperty("merchant").GetString() == m);

        // The quoted merchant kept its embedded comma.
        items.Select(t => t.GetProperty("merchant").GetString()).Should().Contain("Amazon.com, Inc");

        // Negative bank line => expense; magnitude positive, raw negative.
        var tj = ByMerchant("Trader Joes");
        tj.GetProperty("kind").GetString().Should().Be("expense");
        tj.GetProperty("magnitude").GetDecimal().Should().Be(54.20m);
        tj.GetProperty("rawAmount").GetDecimal().Should().Be(-54.20m);

        // Paycheck category => income.
        ByMerchant("ACME Payroll").GetProperty("kind").GetString().Should().Be("income");
        // Transfer category => transfer.
        ByMerchant("Move to savings").GetProperty("kind").GetString().Should().Be("transfer");
        // Bank credit with no category => income.
        ByMerchant("Deposit").GetProperty("kind").GetString().Should().Be("income");
        // Parenthesized negative on a credit card => expense, magnitude 45.67.
        var shell = ByMerchant("Shell Gas");
        shell.GetProperty("kind").GetString().Should().Be("expense");
        shell.GetProperty("magnitude").GetDecimal().Should().Be(45.67m);
        shell.GetProperty("rawAmount").GetDecimal().Should().Be(-45.67m);
        // Credit Card Payment category => transfer (excluded from spending).
        ByMerchant("Payment Thank You").GetProperty("kind").GetString().Should().Be("transfer");
        // Custom Name overrides Name.
        ByMerchant("Chipotle").GetProperty("kind").GetString().Should().Be("expense");

        page.GetRawText().Should().NotContain("@");
    }

    // =====================================================================================
    // DEDUPE — re-importing the same export imports nothing
    // =====================================================================================

    [Fact]
    public async Task Reimporting_the_same_csv_imports_zero_all_deduped()
    {
        var owner = await FinanceUser();

        var first = await Json(await owner.PostAsJsonAsync("/api/family/finance/import",
            new { fileName = "rm.csv", content = SampleCsv }));
        first.GetProperty("imported").GetInt32().Should().Be(8);

        var second = await Json(await owner.PostAsJsonAsync("/api/family/finance/import",
            new { fileName = "rm-again.csv", content = SampleCsv }));
        second.GetProperty("rowCount").GetInt32().Should().Be(8);
        second.GetProperty("imported").GetInt32().Should().Be(0);  // everything already present
        second.GetProperty("skipped").GetInt32().Should().Be(8);

        // No accounts duplicated, no extra transactions.
        var accounts = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        accounts.GetArrayLength().Should().Be(4);
        var page = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        page.GetProperty("total").GetInt32().Should().Be(8);
    }

    // =====================================================================================
    // RELABEL — owner sticks and flows into /summary byOwner
    // =====================================================================================

    [Fact]
    public async Task Relabeling_account_owner_sticks_and_flows_into_summary_byOwner()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        var accounts = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var sofi1Id = Account(accounts, "SoFi Checking 1").GetProperty("id").GetInt32();
        var sofi2Id = Account(accounts, "SoFi Savings 2").GetProperty("id").GetInt32();
        var missionId = Account(accounts, "Mission Lane Card").GetProperty("id").GetInt32();
        var usaaId = Account(accounts, "USAA Card").GetProperty("id").GetInt32();

        // Label the SoFi accounts his/hers (this is how the two SoFi accounts get told apart) and the
        // cards joint.
        (await owner.PutAsJsonAsync($"/api/family/finance/accounts/{sofi1Id}", new { owner = "his" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        await owner.PutAsJsonAsync($"/api/family/finance/accounts/{sofi2Id}", new { owner = "hers" });
        await owner.PutAsJsonAsync($"/api/family/finance/accounts/{missionId}", new { owner = "joint" });
        await owner.PutAsJsonAsync($"/api/family/finance/accounts/{usaaId}", new { owner = "joint" });

        // The label sticks.
        var relisted = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        Account(relisted, "SoFi Checking 1").GetProperty("owner").GetString().Should().Be("his");
        Account(relisted, "SoFi Savings 2").GetProperty("owner").GetString().Should().Be("hers");

        // ...and it flows into /summary byOwner. Spending (expense-only) by owner:
        //   his  = SoFi1 Trader Joes 54.20
        //   hers = SoFi2 Amazon 120.99
        //   joint = Shell 45.67 + Chipotle 12.50 = 58.17
        var summary = await Json(await owner.GetAsync("/api/family/finance/summary?month=2026-05"));
        var byOwner = summary.GetProperty("byOwner").EnumerateArray()
            .ToDictionary(o => o.GetProperty("owner").GetString()!, o => o.GetProperty("amount").GetDecimal());
        byOwner["his"].Should().Be(54.20m);
        byOwner["hers"].Should().Be(120.99m);
        byOwner["joint"].Should().Be(58.17m);
        byOwner.Should().NotContainKey("unassigned"); // every account got labeled
    }

    [Fact]
    public async Task Relabel_rejects_a_bad_owner_and_404s_a_cross_household_account()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        var accounts = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var anId = accounts.EnumerateArray().First().GetProperty("id").GetInt32();

        (await owner.PutAsJsonAsync($"/api/family/finance/accounts/{anId}", new { owner = "theirs" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Another household's user can't see or relabel this account (existence never leaked).
        var (_, other, _) = await ProvisionUser("family.use", "family.finance");
        await other.GetAsync("/api/family/household");
        (await other.PutAsJsonAsync($"/api/family/finance/accounts/{anId}", new { owner = "his" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // SUMMARY — byCategory/byAccount/byOwner; transfers excluded from spending
    // =====================================================================================

    [Fact]
    public async Task Summary_computes_totals_and_excludes_transfers_from_spending()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        var summary = await Json(await owner.GetAsync("/api/family/finance/summary?month=2026-05"));
        summary.GetProperty("month").GetString().Should().Be("2026-05");

        // Spending = EXPENSE magnitudes only: 54.20 + 120.99 + 45.67 + 12.50 = 233.36.
        // The 300 transfer + 200 cc-payment are EXCLUDED; the 2500 paycheck + 75 deposit are income.
        summary.GetProperty("totalSpent").GetDecimal().Should().Be(233.36m);
        summary.GetProperty("totalIncome").GetDecimal().Should().Be(2575.00m);

        // byCategory sums expenses by category and the pct's sum to ~100.
        var byCategory = summary.GetProperty("byCategory").EnumerateArray()
            .ToDictionary(c => c.GetProperty("category").GetString()!, c => c.GetProperty("amount").GetDecimal());
        byCategory["Groceries"].Should().Be(54.20m);
        byCategory["Shopping"].Should().Be(120.99m);
        byCategory["Gas"].Should().Be(45.67m);
        byCategory["Dining"].Should().Be(12.50m);
        byCategory.Should().NotContainKey("Transfer");             // transfers never counted as spending
        byCategory.Should().NotContainKey("Credit Card Payment");
        byCategory.Values.Sum().Should().Be(233.36m);

        // byAccount (expense-only) — SoFi1 only contributes its expense, not the transfer.
        var byAccount = summary.GetProperty("byAccount").EnumerateArray()
            .ToDictionary(a => a.GetProperty("name").GetString()!, a => a.GetProperty("amount").GetDecimal());
        byAccount["SoFi Checking 1"].Should().Be(54.20m);
        byAccount["Mission Lane Card"].Should().Be(45.67m); // not the 200 payment

        // The monthly trend includes the summary month with the same spent/income.
        var trend = summary.GetProperty("monthlyTrend").EnumerateArray().ToList();
        var may = trend.Single(p => p.GetProperty("month").GetString() == "2026-05");
        may.GetProperty("spent").GetDecimal().Should().Be(233.36m);
        may.GetProperty("income").GetDecimal().Should().Be(2575.00m);

        summary.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Transactions_filter_by_kind_and_account()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        var accounts = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var sofi1Id = Account(accounts, "SoFi Checking 1").GetProperty("id").GetInt32();

        // kind=expense over the month: 4 expense rows.
        var expenses = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05&kind=expense"));
        expenses.GetProperty("items").EnumerateArray()
            .Should().OnlyContain(t => t.GetProperty("kind").GetString() == "expense");
        expenses.GetProperty("total").GetInt32().Should().Be(4);

        // accountId filter: SoFi Checking 1 has 3 rows.
        var sofi1 = await Json(await owner.GetAsync($"/api/family/finance/transactions?month=2026-05&accountId={sofi1Id}"));
        sofi1.GetProperty("total").GetInt32().Should().Be(3);
        sofi1.GetProperty("items").EnumerateArray()
            .Should().OnlyContain(t => t.GetProperty("accountId").GetInt32() == sofi1Id);
    }

    // =====================================================================================
    // IMPORTS LIST — recent batches, importer by userId + name (no email)
    // =====================================================================================

    [Fact]
    public async Task Imports_list_returns_batches_with_importer_by_id_and_name_no_email()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use", "family.finance");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "may-export.csv", content = SampleCsv });

        var imports = await Json(await owner.GetAsync("/api/family/finance/imports"));
        imports.GetArrayLength().Should().BeGreaterThanOrEqualTo(1);
        var batch = imports.EnumerateArray().First();
        batch.GetProperty("fileName").GetString().Should().Be("may-export.csv");
        batch.GetProperty("rowCount").GetInt32().Should().Be(8);
        batch.GetProperty("importedCount").GetInt32().Should().Be(8);
        batch.GetProperty("skippedCount").GetInt32().Should().Be(0);
        batch.GetProperty("importedByUserId").GetInt32().Should().Be(ownerId);
        batch.GetProperty("importedByName").GetString().Should().NotBeNullOrWhiteSpace();
        HasProperty(batch, "importedByEmail").Should().BeFalse();
        imports.GetRawText().Should().NotContain("@");
    }

    // =====================================================================================
    // CROSS-HOUSEHOLD ISOLATION — finance data never leaks across households
    // =====================================================================================

    [Fact]
    public async Task Finance_data_is_household_isolated()
    {
        var alice = await FinanceUser();
        var bob = await FinanceUser();

        await alice.PostAsJsonAsync("/api/family/finance/import", new { fileName = "alice.csv", content = SampleCsv });

        // Bob's household has no accounts or transactions from Alice's import.
        var bobAccounts = await Json(await bob.GetAsync("/api/family/finance/accounts"));
        bobAccounts.GetArrayLength().Should().Be(0);
        var bobTxns = await Json(await bob.GetAsync("/api/family/finance/transactions?month=2026-05"));
        bobTxns.GetProperty("total").GetInt32().Should().Be(0);
        var bobImports = await Json(await bob.GetAsync("/api/family/finance/imports"));
        bobImports.GetArrayLength().Should().Be(0);

        // Bob's summary for the same month is empty (no spending).
        var bobSummary = await Json(await bob.GetAsync("/api/family/finance/summary?month=2026-05"));
        bobSummary.GetProperty("totalSpent").GetDecimal().Should().Be(0m);
    }

    // =====================================================================================
    // AI "EXPLAIN THIS MONTH" — read-only narration; deterministic plain FLOOR; writes nothing
    // =====================================================================================

    [Fact]
    public async Task Ai_summary_falls_back_to_deterministic_plain_summary_never_503_and_writes_nothing()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        // Snapshot the data BEFORE the AI call so we can assert it mutates nothing.
        var accountsBefore = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var txnsBefore = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));

        // Gemini is OFF in the test host → ALWAYS 200 with the deterministic plain floor, never 503/500.
        var res = await owner.GetAsync("/api/family/finance/ai/summary?month=2026-05");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);

        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        var narrative = dto.GetProperty("narrative").GetString();
        narrative.Should().NotBeNullOrWhiteSpace();
        // The plain floor narrates the SAME server math as GET /summary: spent 233.36, top category Shopping.
        narrative.Should().Contain("233.36");
        narrative.Should().Contain("Shopping");
        // No insights when falling back to the plain floor.
        dto.GetProperty("insights").GetArrayLength().Should().Be(0);
        // No email anywhere (there is none in finance).
        dto.GetRawText().Should().NotContain("@");

        // The read changed NOTHING: same accounts, same transactions.
        var accountsAfter = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var txnsAfter = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        accountsAfter.GetArrayLength().Should().Be(accountsBefore.GetArrayLength());
        txnsAfter.GetProperty("total").GetInt32().Should().Be(txnsBefore.GetProperty("total").GetInt32());

        // No new import batch was created by the read.
        var imports = await Json(await owner.GetAsync("/api/family/finance/imports"));
        imports.GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task Ai_summary_for_an_empty_month_returns_a_friendly_summary_without_calling_the_model()
    {
        var owner = await FinanceUser(); // no import — the household has no transactions at all

        var res = await owner.GetAsync("/api/family/finance/ai/summary?month=2026-05");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);

        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("narrative").GetString().Should().Contain("No spending recorded");
        dto.GetProperty("insights").GetArrayLength().Should().Be(0);
    }

    // =====================================================================================
    // AI "MONEY COACH" — DETERMINISTIC recurring detector is the FLOOR; never 503; writes nothing
    // =====================================================================================

    /// <summary>An export with a recurring subscription (3 monthly Netflix charges, same amount, across 3
    /// distinct months) plus a one-off purchase that must NOT be flagged as recurring.</summary>
    private const string RecurringCsv =
        "Date,Original Date,Account Type,Account Name,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible\n" +
        "2026-03-05,2026-03-05,Checking,SoFi Checking 1,SoFi,Netflix,,-15.99,sub,Entertainment,,,\n" +
        "2026-04-05,2026-04-05,Checking,SoFi Checking 1,SoFi,Netflix.com,,-15.99,sub,Entertainment,,,\n" +
        "2026-05-05,2026-05-05,Checking,SoFi Checking 1,SoFi,NETFLIX #4471,,-15.99,sub,Entertainment,,,\n" +
        // A one-off purchase in a single month — must be EXCLUDED from recurring.
        "2026-05-12,2026-05-12,Checking,SoFi Checking 1,SoFi,Best Buy,,-499.00,tv,Shopping,,,\n";

    [Fact]
    public async Task Money_coach_detects_recurring_charges_as_the_floor_never_503_and_writes_nothing()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import",
            new { fileName = "recurring.csv", content = RecurringCsv });

        // Snapshot the data BEFORE the AI call so we can assert it mutates nothing.
        var accountsBefore = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var txnsBefore = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));

        // Gemini is OFF -> ALWAYS 200 with the DETERMINISTIC recurring floor, never 503/500.
        var res = await owner.GetAsync("/api/family/finance/ai/money-coach");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);

        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();

        // The recurring list is the authoritative floor: exactly one recurring charge (the 3 Netflix variants
        // collapse to one), and the one-off Best Buy is excluded.
        var recurring = dto.GetProperty("recurring").EnumerateArray().ToList();
        recurring.Should().ContainSingle();
        var netflix = recurring[0];
        netflix.GetProperty("typicalAmount").GetDecimal().Should().Be(15.99m);
        netflix.GetProperty("cadence").GetString().Should().Be("monthly");
        netflix.GetProperty("monthsSeen").GetInt32().Should().Be(3);
        recurring.Select(r => r.GetProperty("merchant").GetString())
            .Should().NotContain("Best Buy");

        // The monthly recurring total is the sum of the typical amounts.
        dto.GetProperty("monthlyRecurringTotal").GetDecimal().Should().Be(15.99m);
        // No narrative/tips when falling back (the floor drops them).
        dto.GetProperty("tips").GetArrayLength().Should().Be(0);
        // No email anywhere (there is none in finance).
        dto.GetRawText().Should().NotContain("@");

        // The read changed NOTHING: same accounts, same transactions, no new import batch.
        var accountsAfter = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var txnsAfter = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        accountsAfter.GetArrayLength().Should().Be(accountsBefore.GetArrayLength());
        txnsAfter.GetProperty("total").GetInt32().Should().Be(txnsBefore.GetProperty("total").GetInt32());
        var imports = await Json(await owner.GetAsync("/api/family/finance/imports"));
        imports.GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task Money_coach_with_no_recurring_charges_returns_an_empty_floor()
    {
        var owner = await FinanceUser(); // no import — nothing to detect

        var res = await owner.GetAsync("/api/family/finance/ai/money-coach");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("recurring").GetArrayLength().Should().Be(0);
        dto.GetProperty("monthlyRecurringTotal").GetDecimal().Should().Be(0m);
        dto.GetProperty("tips").GetArrayLength().Should().Be(0);
    }
}
