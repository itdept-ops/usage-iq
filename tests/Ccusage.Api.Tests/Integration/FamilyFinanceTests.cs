using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;

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

    /// <summary>Today in the app's display timezone — the SAME "today" the finance balance default-date uses
    /// (<see cref="TrackerVisibility.DisplayTzTodayAsync"/>). Resolved from the live host so the assertion can
    /// never be a time-of-day-flaky raw-UTC date.</summary>
    private async Task<DateOnly> DisplayTzToday()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await TrackerVisibility.DisplayTzTodayAsync(db, CancellationToken.None);
    }

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
    public async Task Ai_summary_is_NOT_blocked_for_a_finance_caller_without_finance_ai_but_returns_the_plain_floor()
    {
        // The floored /ai/summary is NOT gated at the filter — a family.use+family.finance caller WITHOUT
        // finance.ai still gets a 200 plain floor (the LLM narration is the finance.ai-gated upgrade; the
        // deterministic numbers are everyone's). finance.ai is checked INSIDE the handler, not as a 403.
        var owner = await FinanceUser(); // family.use + family.finance, NO finance.ai
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        var res = await owner.GetAsync("/api/family/finance/ai/summary?month=2026-05");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("narrative").GetString().Should().Contain("233.36");
    }

    [Fact]
    public async Task Money_coach_is_NOT_blocked_for_a_finance_caller_without_finance_ai_but_returns_the_plain_floor()
    {
        // Same floor contract for the money coach: the deterministic recurring-charge detector is the floor for
        // any family.finance caller; only the warm narration/tips are the finance.ai upgrade.
        var owner = await FinanceUser(); // no finance.ai
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        var res = await owner.GetAsync("/api/family/finance/ai/money-coach");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
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

    // =====================================================================================
    // STAGING — parse → review → commit (parse never touches the live ledger)
    // =====================================================================================

    /// <summary>A generic (non-Rocket-Money) bank CSV with its own column names + a Debit/Credit pair —
    /// requires a column map. Two expense rows (debit) and one income row (credit).</summary>
    private const string GenericCsv =
        "Posted,Payee,Memo,Money Out,Money In,Bucket\n" +
        "2026-05-03,Trader Joes,groceries,54.20,,Groceries\n" +
        "2026-05-05,Mystery Shop,unknown,30.00,,\n" +
        "2026-05-15,Paycheck,wages,,2000.00,Income\n";

    private static object GenericMap() => new
    {
        date = "Posted",
        debit = "Money Out",
        credit = "Money In",
        negate = false,
        description = "Payee",
        category = "Bucket",
        accountName = "Chase Checking",
        institution = "Chase",
    };

    /// <summary>A tiny OFX statement: one bank STMTTRN with a FITID, plus a second distinct one.</summary>
    private const string SampleOfx =
        "OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>" +
        "<BANKACCTFROM><BANKID>123456789</BANKID><ACCTID>000111222</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>" +
        "<BANKTRANLIST>" +
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503120000<TRNAMT>-54.20<FITID>FIT-AAA<NAME>Trader Joes</STMTTRN>" +
        "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260501<TRNAMT>2500.00<FITID>FIT-BBB<NAME>ACME Payroll</STMTTRN>" +
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

    private async Task<long> ParseStaged(HttpClient c, object body)
    {
        var res = await c.PostAsJsonAsync("/api/family/finance/import/parse", body);
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(res)).GetProperty("importId").GetInt64();
    }

    [Fact]
    public async Task Parse_stages_rows_without_touching_the_live_ledger_then_commit_materializes_them()
    {
        var owner = await FinanceUser();

        // PARSE a Rocket Money file -> a STAGED batch. The live ledger stays empty.
        var parseRes = await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "rm.csv", content = SampleCsv });
        parseRes.StatusCode.Should().Be(HttpStatusCode.OK);
        var staged = await Json(parseRes);
        staged.GetProperty("format").GetString().Should().Be("rocketmoney");
        staged.GetProperty("parsedCount").GetInt32().Should().Be(8);
        staged.GetProperty("duplicateCount").GetInt32().Should().Be(0);
        staged.GetProperty("accounts").GetArrayLength().Should().Be(4);
        staged.GetRawText().Should().NotContain("@");
        var importId = staged.GetProperty("importId").GetInt64();

        // The live ledger is UNTOUCHED before commit.
        (await Json(await owner.GetAsync("/api/family/finance/accounts"))).GetArrayLength().Should().Be(0);
        (await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05")))
            .GetProperty("total").GetInt32().Should().Be(0);

        // The deterministic categorizer ran (file categories preserved, source "file").
        var rows = staged.GetProperty("rows").EnumerateArray().ToList();
        var tj = rows.Single(r => r.GetProperty("merchant").GetString() == "Trader Joes");
        tj.GetProperty("category").GetString().Should().Be("Groceries");
        tj.GetProperty("categorySource").GetString().Should().Be("file");

        // COMMIT -> the ledger is materialized.
        var commit = await owner.PostAsJsonAsync($"/api/family/finance/import/{importId}/commit", new { });
        commit.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(commit)).GetProperty("imported").GetInt32().Should().Be(8);

        (await Json(await owner.GetAsync("/api/family/finance/accounts"))).GetArrayLength().Should().Be(4);
        (await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05")))
            .GetProperty("total").GetInt32().Should().Be(8);

        // The batch is now committed; the staged rows are gone.
        (await owner.GetAsync($"/api/family/finance/import/{importId}/staged"))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        var stagedAfter = await Json(await owner.GetAsync($"/api/family/finance/import/{importId}/staged"));
        stagedAfter.GetProperty("total").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task Generic_csv_with_a_column_map_and_debit_credit_pair_parses_and_categorizes()
    {
        var owner = await FinanceUser();

        var res = await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "bank.csv", content = GenericCsv, format = "csv", columnMap = GenericMap() });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var staged = await Json(res);
        staged.GetProperty("format").GetString().Should().Be("csv");
        staged.GetProperty("parsedCount").GetInt32().Should().Be(3);
        staged.GetProperty("detectedColumns").EnumerateArray().Select(c => c.GetString())
            .Should().Contain("Money Out").And.Contain("Money In");

        var rows = staged.GetProperty("rows").EnumerateArray().ToList();
        // Debit row -> expense, negative raw; the default map categorizes Trader Joes -> Groceries when no file cat,
        // but here the file's Bucket=Groceries wins (source file).
        var tj = rows.Single(r => r.GetProperty("merchant").GetString() == "Trader Joes");
        tj.GetProperty("kind").GetString().Should().Be("expense");
        tj.GetProperty("rawAmount").GetDecimal().Should().Be(-54.20m);
        tj.GetProperty("category").GetString().Should().Be("Groceries");

        // The row with no file category but a known merchant... "Mystery Shop" is unknown -> Uncategorized.
        var mystery = rows.Single(r => r.GetProperty("merchant").GetString() == "Mystery Shop");
        mystery.GetProperty("category").ValueKind.Should().Be(JsonValueKind.Null);
        mystery.GetProperty("categorySource").GetString().Should().Be("none");

        // Credit row -> positive raw (money in).
        var pay = rows.Single(r => r.GetProperty("merchant").GetString() == "Paycheck");
        pay.GetProperty("rawAmount").GetDecimal().Should().Be(2000.00m);

        // A generic CSV with NO column map is a 400.
        (await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "bank.csv", content = GenericCsv, format = "csv" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Default_merchant_map_categorizes_an_uncategorized_row()
    {
        var owner = await FinanceUser();
        // A generic CSV row with NO category column value but a known merchant -> default map assigns it (source rule).
        var csv = "Posted,Payee,Money Out,Money In\n2026-05-03,NETFLIX #4471,15.99,\n";
        var map = new { date = "Posted", debit = "Money Out", credit = "Money In", description = "Payee", accountName = "Chk" };

        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "b.csv", content = csv, format = "csv", columnMap = map }));
        var row = staged.GetProperty("rows").EnumerateArray().Single();
        row.GetProperty("category").GetString().Should().Be("Subscriptions");
        row.GetProperty("categorySource").GetString().Should().Be("rule");
    }

    [Fact]
    public async Task Ofx_parses_with_fitid_and_dedups_a_cross_format_reimport_so_no_double_count()
    {
        var owner = await FinanceUser();

        // First import the SAME two transactions via Rocket Money (committed), then re-import via OFX.
        // Institution must match the OFX BANKID (123456789) so the content dedup hash lines up cross-format.
        var rmCsv =
            "Date,Account Type,Account Name,Institution Name,Name,Amount,Category\n" +
            "2026-05-03,Checking,Account 1222,123456789,Trader Joes,-54.20,Groceries\n" +
            "2026-05-01,Checking,Account 1222,123456789,ACME Payroll,2500.00,Paycheck\n";
        // Match the OFX account/institution so the content dedup hash lines up (cross-format bridge).
        var rmId = await ParseStaged(owner, new { fileName = "rm.csv", content = rmCsv, format = "rocketmoney" });
        (await owner.PostAsJsonAsync($"/api/family/finance/import/{rmId}/commit", new { }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        var before = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        before.GetProperty("total").GetInt32().Should().Be(2);

        // Now parse the OFX of the same statement. ORG isn't set so institution comes from BANKID; the OFX
        // account name "Account 1222" matches (ACCTID last4) -> same account key -> same content hash -> dups.
        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "statement.ofx", content = SampleOfx }));
        staged.GetProperty("format").GetString().Should().Be("ofx");
        staged.GetProperty("parsedCount").GetInt32().Should().Be(2);
        // The two OFX rows carry FITIDs; both already exist in the committed ledger by content hash -> duplicates.
        staged.GetProperty("duplicateCount").GetInt32().Should().Be(2);

        // Commit the OFX batch: the duplicates are SKIPPED -> the ledger still has 2 (no double-count).
        var ofxId = staged.GetProperty("importId").GetInt64();
        var commit = await Json(await owner.PostAsJsonAsync($"/api/family/finance/import/{ofxId}/commit", new { }));
        commit.GetProperty("imported").GetInt32().Should().Be(0);
        var after = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        after.GetProperty("total").GetInt32().Should().Be(2);
    }

    [Fact]
    public async Task Within_batch_fitid_duplicate_is_flagged_and_skipped_on_commit()
    {
        var owner = await FinanceUser();
        // Two STMTTRN with the SAME FITID (and same content) -> the second is a within-batch duplicate.
        var ofx =
            "<OFX><STMTTRN><DTPOSTED>20260503<TRNAMT>-12.00<FITID>DUP1<NAME>Coffee</STMTTRN>" +
            "<STMTTRN><DTPOSTED>20260503<TRNAMT>-12.00<FITID>DUP1<NAME>Coffee</STMTTRN></OFX>";

        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "s.ofx", content = ofx }));
        staged.GetProperty("parsedCount").GetInt32().Should().Be(2);
        staged.GetProperty("duplicateCount").GetInt32().Should().Be(1);

        var id = staged.GetProperty("importId").GetInt64();
        var commit = await Json(await owner.PostAsJsonAsync($"/api/family/finance/import/{id}/commit", new { }));
        commit.GetProperty("imported").GetInt32().Should().Be(1); // only the first; the duplicate is skipped
    }

    /// <summary>Two genuinely-DISTINCT OFX transactions with identical (date|amount|NAME|empty MEMO) content but
    /// DIFFERENT FITIDs — e.g. two $4.50 coffees the same day. FITID is authoritative, so neither is a duplicate
    /// and BOTH commit. (Before the fix, the content DedupHash was treated as authoritative even for FITID rows,
    /// so the second was wrongly dropped → under-count.)</summary>
    [Fact]
    public async Task Two_distinct_fitids_with_identical_content_both_import_no_under_count()
    {
        var owner = await FinanceUser();
        // Same date, same -4.50, same NAME "Coffee Shop", empty MEMO — only the FITID differs.
        var ofx =
            "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>" +
            "<BANKACCTFROM><BANKID>999</BANKID><ACCTID>000000123</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>" +
            "<BANKTRANLIST>" +
            "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-4.50<FITID>COFFEE-1<NAME>Coffee Shop</STMTTRN>" +
            "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-4.50<FITID>COFFEE-2<NAME>Coffee Shop</STMTTRN>" +
            "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "coffee.ofx", content = ofx }));
        staged.GetProperty("format").GetString().Should().Be("ofx");
        staged.GetProperty("parsedCount").GetInt32().Should().Be(2);
        // Distinct FITIDs => NEITHER is a duplicate even though the content hash matches.
        staged.GetProperty("duplicateCount").GetInt32().Should().Be(0);

        var id = staged.GetProperty("importId").GetInt64();
        var commit = await Json(await owner.PostAsJsonAsync($"/api/family/finance/import/{id}/commit", new { }));
        commit.GetProperty("imported").GetInt32().Should().Be(2); // BOTH coffees land in the ledger

        var ledger = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        ledger.GetProperty("total").GetInt32().Should().Be(2);
    }

    /// <summary>Re-importing the SAME OFX file (same FITIDs) in a SECOND batch flags every row a duplicate against
    /// the committed (now FITID-persisted) ledger, so the commit adds 0 — no double-count.</summary>
    [Fact]
    public async Task Reimporting_the_same_ofx_dedups_by_committed_fitid_no_double_count()
    {
        var owner = await FinanceUser();
        var ofx =
            "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>" +
            "<BANKACCTFROM><BANKID>999</BANKID><ACCTID>000000123</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>" +
            "<BANKTRANLIST>" +
            "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-4.50<FITID>COFFEE-1<NAME>Coffee Shop</STMTTRN>" +
            "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-4.50<FITID>COFFEE-2<NAME>Coffee Shop</STMTTRN>" +
            "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

        // First import: both distinct FITIDs commit.
        var firstId = await ParseStaged(owner, new { fileName = "coffee.ofx", content = ofx });
        (await Json(await owner.PostAsJsonAsync($"/api/family/finance/import/{firstId}/commit", new { })))
            .GetProperty("imported").GetInt32().Should().Be(2);

        // Re-import the SAME file: both FITIDs are now committed => both flagged duplicate.
        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "coffee-again.ofx", content = ofx }));
        staged.GetProperty("parsedCount").GetInt32().Should().Be(2);
        staged.GetProperty("duplicateCount").GetInt32().Should().Be(2);

        var secondId = staged.GetProperty("importId").GetInt64();
        var commit = await Json(await owner.PostAsJsonAsync($"/api/family/finance/import/{secondId}/commit", new { }));
        commit.GetProperty("imported").GetInt32().Should().Be(0); // nothing re-added

        // The ledger still has exactly the original 2 (no double-count).
        var ledger = await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05"));
        ledger.GetProperty("total").GetInt32().Should().Be(2);
    }

    [Fact]
    public async Task Commit_excludes_rows_and_a_patched_exclude_is_honored()
    {
        var owner = await FinanceUser();
        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "rm.csv", content = SampleCsv }));
        var importId = staged.GetProperty("importId").GetInt64();
        var firstRow = staged.GetProperty("rows").EnumerateArray().First();
        var rowId = firstRow.GetProperty("id").GetInt64();

        // PATCH the row to excluded + change its category with apply-to-future.
        var patch = await owner.PatchAsync($"/api/family/finance/import/{importId}/rows/{rowId}",
            JsonContent.Create(new { excluded = true, category = "Dining", applyToFuture = true }));
        patch.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(patch)).GetProperty("excluded").GetBoolean().Should().BeTrue();

        // Commit -> the excluded row is NOT in the ledger (7 of 8).
        var commit = await Json(await owner.PostAsJsonAsync($"/api/family/finance/import/{importId}/commit", new { }));
        commit.GetProperty("imported").GetInt32().Should().Be(7);
    }

    [Fact]
    public async Task Discard_removes_a_staged_batch_and_a_committed_batch_cannot_be_discarded_or_recommitted()
    {
        var owner = await FinanceUser();
        var stagedId = await ParseStaged(owner, new { fileName = "rm.csv", content = SampleCsv });

        // DISCARD a staged batch -> staged rows gone, ledger untouched.
        (await owner.DeleteAsync($"/api/family/finance/import/{stagedId}"))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Json(await owner.GetAsync("/api/family/finance/transactions?month=2026-05")))
            .GetProperty("total").GetInt32().Should().Be(0);

        // Commit a fresh batch, then re-committing or discarding it is rejected (committed is immutable).
        var id = await ParseStaged(owner, new { fileName = "rm2.csv", content = SampleCsv });
        (await owner.PostAsJsonAsync($"/api/family/finance/import/{id}/commit", new { }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await owner.PostAsJsonAsync($"/api/family/finance/import/{id}/commit", new { }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await owner.DeleteAsync($"/api/family/finance/import/{id}"))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Staged_batch_is_household_isolated_cross_household_importId_is_404()
    {
        var alice = await FinanceUser();
        var bob = await FinanceUser();

        var aliceImport = await ParseStaged(alice, new { fileName = "a.csv", content = SampleCsv });

        // Bob can't see, review, categorize, patch, commit, or discard Alice's staged batch — all 404
        // (existence is never leaked).
        (await bob.GetAsync($"/api/family/finance/import/{aliceImport}/staged"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/family/finance/import/{aliceImport}/categorize-ai", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PatchAsync($"/api/family/finance/import/{aliceImport}/rows/1",
            JsonContent.Create(new { category = "Dining" }))).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/family/finance/import/{aliceImport}/commit", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/finance/import/{aliceImport}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Alice's staged batch is intact + uncommitted; Bob's ledger is empty.
        (await Json(await alice.GetAsync($"/api/family/finance/import/{aliceImport}/staged")))
            .GetProperty("total").GetInt32().Should().Be(8);
        (await Json(await bob.GetAsync("/api/family/finance/transactions?month=2026-05")))
            .GetProperty("total").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task Categorize_ai_floors_to_rows_unchanged_when_ai_is_off_and_never_blocks_commit()
    {
        var owner = await FinanceUser(); // family.use + family.finance, NO finance.ai, Gemini OFF in tests
        // A generic CSV with an Uncategorized unknown merchant (no file cat, not in the default map).
        var csv = "Posted,Payee,Money Out,Money In\n2026-05-03,Zzyzx Widgets LLC,40.00,\n";
        var map = new { date = "Posted", debit = "Money Out", credit = "Money In", description = "Payee", accountName = "Chk" };
        var staged = await Json(await owner.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "b.csv", content = csv, format = "csv", columnMap = map }));
        var importId = staged.GetProperty("importId").GetInt64();
        staged.GetProperty("rows").EnumerateArray().Single()
            .GetProperty("category").ValueKind.Should().Be(JsonValueKind.Null);

        // categorize-ai -> floored (no finance.ai + Gemini off): 0 classified, fellBackToPlain true, NEVER 503.
        var ai = await owner.PostAsJsonAsync($"/api/family/finance/import/{importId}/categorize-ai", new { });
        ai.StatusCode.Should().Be(HttpStatusCode.OK);
        var aiDto = await Json(ai);
        aiDto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        aiDto.GetProperty("classified").GetInt32().Should().Be(0);

        // The row stayed Uncategorized, and the commit still works (AI never blocks it).
        var review = await Json(await owner.GetAsync($"/api/family/finance/import/{importId}/staged"));
        review.GetProperty("items").EnumerateArray().Single()
            .GetProperty("category").ValueKind.Should().Be(JsonValueKind.Null);
        (await owner.PostAsJsonAsync($"/api/family/finance/import/{importId}/commit", new { }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Parse_route_requires_family_finance()
    {
        var (_, useOnly, _) = await ProvisionUser("family.use");
        await useOnly.GetAsync("/api/family/household");
        (await useOnly.PostAsJsonAsync("/api/family/finance/import/parse",
            new { fileName = "x.csv", content = SampleCsv })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/import/1/staged"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // =====================================================================================
    // BUDGETS — deterministic spend-vs-budget by PACE (expense-only); unbudgeted rollup
    // =====================================================================================

    private static JsonElement BudgetFor(JsonElement budgets, string? category) =>
        budgets.EnumerateArray().Single(b =>
            (b.GetProperty("category").ValueKind == JsonValueKind.Null ? null : b.GetProperty("category").GetString())
            == category);

    [Fact]
    public async Task Budget_spend_is_expense_only_excludes_transfers_and_remaining_is_correct()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        // A Groceries budget of $100 for May 2026 (the month has a single $54.20 Groceries expense).
        var create = await owner.PostAsJsonAsync("/api/family/finance/budgets",
            new { category = "Groceries", limitAmount = 100.00m });
        create.StatusCode.Should().Be(HttpStatusCode.OK);

        var res = await Json(await owner.GetAsync("/api/family/finance/budgets?month=2026-05"));
        res.GetProperty("month").GetString().Should().Be("2026-05");
        // The month total spent is the SAME expense-only figure /summary computes (transfers excluded).
        res.GetProperty("totalSpent").GetDecimal().Should().Be(233.36m);

        var groceries = BudgetFor(res.GetProperty("budgets"), "Groceries");
        groceries.GetProperty("spent").GetDecimal().Should().Be(54.20m);    // expense only
        groceries.GetProperty("remaining").GetDecimal().Should().Be(45.80m); // 100 - 54.20
        groceries.GetProperty("status").GetString().Should().Be("under");

        // The unbudgeted rollup = the rest of the month's expenses (everything but Groceries).
        var unbudgeted = res.GetProperty("unbudgeted");
        unbudgeted.GetProperty("spent").GetDecimal().Should().Be(233.36m - 54.20m); // 179.16
        res.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Budget_pace_projection_marks_over_when_projected_exceeds_limit()
    {
        var owner = await FinanceUser();
        // A current-month expense so the pace projection extrapolates: spend $100 on day 1 of THIS month with a
        // $200 budget. By pace (100 / day1 * daysInMonth) the projection far exceeds 200 -> status "over".
        var today = DateTime.UtcNow;
        var monthStr = today.ToString("yyyy-MM");
        var csv =
            "Date,Account Type,Account Name,Institution Name,Name,Amount,Category\n" +
            $"{today:yyyy-MM}-01,Checking,Chk,Bank,Big Spend,-100.00,Shopping\n";
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "p.csv", content = csv });
        await owner.PostAsJsonAsync("/api/family/finance/budgets",
            new { category = "Shopping", limitAmount = 200.00m });

        var res = await Json(await owner.GetAsync($"/api/family/finance/budgets?month={monthStr}"));
        var shopping = BudgetFor(res.GetProperty("budgets"), "Shopping");
        shopping.GetProperty("spent").GetDecimal().Should().Be(100.00m);
        // Projected = 100 / dayOfMonth * daysInMonth. Only equals 100 on the final day of the month; otherwise
        // it's strictly greater and, being > the $200 limit by pace whenever we're early enough, marks "over".
        var projected = shopping.GetProperty("projected").GetDecimal();
        if (today.Day < DateTime.DaysInMonth(today.Year, today.Month))
        {
            projected.Should().BeGreaterThan(100.00m);
            // For the first ~half of the month the pace doubles past 200 → "over". Assert the math, not the day:
            var expected = Math.Round(100.00m / today.Day * DateTime.DaysInMonth(today.Year, today.Month), 2);
            projected.Should().Be(expected);
            shopping.GetProperty("status").GetString().Should()
                .Be(expected > 200m ? "over" : (double)(expected / 200m) >= 0.85 ? "near" : "under");
        }
    }

    [Fact]
    public async Task Overall_budget_uses_whole_month_spend_and_pct_is_correct()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });

        // An OVERALL (null-category) budget of $500 — checked against the whole-month $233.36 spend.
        await owner.PostAsJsonAsync("/api/family/finance/budgets", new { category = (string?)null, limitAmount = 500.00m });

        var res = await Json(await owner.GetAsync("/api/family/finance/budgets?month=2026-05"));
        var overall = BudgetFor(res.GetProperty("budgets"), null);
        overall.GetProperty("spent").GetDecimal().Should().Be(233.36m);
        overall.GetProperty("pct").GetDouble().Should().BeApproximately(46.7, 0.1); // 233.36 / 500
    }

    [Fact]
    public async Task Duplicate_budget_category_is_409_and_cross_household_budget_id_is_404()
    {
        var alice = await FinanceUser();
        var first = await alice.PostAsJsonAsync("/api/family/finance/budgets",
            new { category = "Dining", limitAmount = 50m });
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var budgetId = (await Json(first)).GetProperty("id").GetInt32();

        // A second budget for the same category collides on the unique (household, category) index → 409.
        (await alice.PostAsJsonAsync("/api/family/finance/budgets",
            new { category = "Dining", limitAmount = 75m })).StatusCode.Should().Be(HttpStatusCode.Conflict);

        // Another household can't see/edit/delete Alice's budget — existence never leaked (404, not 403).
        var bob = await FinanceUser();
        (await bob.PutAsJsonAsync($"/api/family/finance/budgets/{budgetId}", new { limitAmount = 999m }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/finance/budgets/{budgetId}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // NET WORTH — signed snapshots; liabilities negative; latest snapshot per account
    // =====================================================================================

    [Fact]
    public async Task Net_worth_signs_liabilities_negative_and_uses_latest_snapshot_per_account()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        var accounts = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var bankId = Account(accounts, "SoFi Checking 1").GetProperty("id").GetInt32();   // bank → asset (positive)
        var cardId = Account(accounts, "Mission Lane Card").GetProperty("id").GetInt32(); // credit → liability (negative)

        // Enter a bank balance (+5000 asset) and a credit balance (-1200 liability). The credit is entered as a
        // NEGATIVE signed number per the kind convention.
        (await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = 5000.00m })).StatusCode.Should().Be(HttpStatusCode.OK);
        await owner.PostAsJsonAsync($"/api/family/finance/accounts/{cardId}/balance",
            new { asOfDate = "2026-05-01", balance = -1200.00m });

        // A LATER snapshot for the bank account supersedes the earlier one (latest-wins).
        await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-06-01", balance = 5500.00m });

        var nw = await Json(await owner.GetAsync("/api/family/finance/net-worth"));
        nw.GetProperty("assets").GetDecimal().Should().Be(5500.00m);        // the LATEST bank snapshot
        nw.GetProperty("liabilities").GetDecimal().Should().Be(-1200.00m);  // negative (a liability)
        nw.GetProperty("netWorth").GetDecimal().Should().Be(4300.00m);      // 5500 + (-1200)

        // The per-account row carries the latest signed balance + as-of date; accounts w/o a snapshot show hasBalance=false.
        var bankRow = nw.GetProperty("accounts").EnumerateArray()
            .Single(a => a.GetProperty("accountId").GetInt32() == bankId);
        bankRow.GetProperty("latestBalance").GetDecimal().Should().Be(5500.00m);
        bankRow.GetProperty("asOfDate").GetString().Should().Be("2026-06-01");
        bankRow.GetProperty("hasBalance").GetBoolean().Should().BeTrue();
        nw.GetProperty("accounts").EnumerateArray()
            .Single(a => a.GetProperty("name").GetString() == "USAA Card")
            .GetProperty("hasBalance").GetBoolean().Should().BeFalse(); // never entered

        nw.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Balance_entry_upserts_on_same_day_and_cross_household_account_is_404()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        var accounts = await Json(await owner.GetAsync("/api/family/finance/accounts"));
        var bankId = Account(accounts, "SoFi Checking 1").GetProperty("id").GetInt32();

        await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = 1000.00m });
        // Same day, new value → upsert (latest-wins), NOT a second row.
        await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = 1234.00m });

        var nw = await Json(await owner.GetAsync("/api/family/finance/net-worth"));
        nw.GetProperty("assets").GetDecimal().Should().Be(1234.00m); // the upserted value, not 1000+1234

        // Another household can't post a balance to Alice's account — 404 (existence never leaked).
        var bob = await FinanceUser();
        (await bob.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = 9.99m })).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // SAVINGS GOALS — saved/target/pct; a contribution updates pct; cross-household → 404
    // =====================================================================================

    [Fact]
    public async Task Savings_contribution_updates_saved_and_pct()
    {
        var owner = await FinanceUser();

        var create = await owner.PostAsJsonAsync("/api/family/finance/savings",
            new { name = "Emergency fund", targetAmount = 1000.00m, owner = "joint" });
        create.StatusCode.Should().Be(HttpStatusCode.OK);
        var goal = await Json(create);
        var goalId = goal.GetProperty("id").GetInt32();
        goal.GetProperty("savedAmount").GetDecimal().Should().Be(0m);
        goal.GetProperty("pct").GetDouble().Should().Be(0.0);
        goal.GetProperty("owner").GetString().Should().Be("joint"); // reuses his/hers/joint/unassigned vocab

        // Contribute $250 → saved 250, pct 25.
        var contributed = await Json(await owner.PostAsJsonAsync(
            $"/api/family/finance/savings/{goalId}/contribute", new { amount = 250.00m }));
        contributed.GetProperty("savedAmount").GetDecimal().Should().Be(250.00m);
        contributed.GetProperty("pct").GetDouble().Should().Be(25.0);

        // A withdrawal floors saved at 0 (never negative).
        var withdrawn = await Json(await owner.PostAsJsonAsync(
            $"/api/family/finance/savings/{goalId}/contribute", new { amount = -9999.00m }));
        withdrawn.GetProperty("savedAmount").GetDecimal().Should().Be(0m);
        withdrawn.GetProperty("pct").GetDouble().Should().Be(0.0);

        // The list reports combined saved/target.
        var list = await Json(await owner.GetAsync("/api/family/finance/savings"));
        list.GetProperty("totalTarget").GetDecimal().Should().Be(1000.00m);
        list.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Savings_goal_is_household_isolated_cross_household_id_is_404()
    {
        var alice = await FinanceUser();
        var goalId = (await Json(await alice.PostAsJsonAsync("/api/family/finance/savings",
            new { name = "Trip", targetAmount = 500m }))).GetProperty("id").GetInt32();

        var bob = await FinanceUser();
        (await bob.PutAsJsonAsync($"/api/family/finance/savings/{goalId}", new { name = "Hijack" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/family/finance/savings/{goalId}/contribute", new { amount = 100m }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/finance/savings/{goalId}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Bob's own savings list is empty (Alice's goal never leaks).
        (await Json(await bob.GetAsync("/api/family/finance/savings")))
            .GetProperty("goals").GetArrayLength().Should().Be(0);
    }

    // =====================================================================================
    // AI "BUDGET CHECK-IN" — deterministic over/near/under floor; never 503; writes nothing
    // =====================================================================================

    [Fact]
    public async Task Budget_check_floors_to_deterministic_status_when_ai_off_never_503_and_writes_nothing()
    {
        var owner = await FinanceUser(); // no finance.ai, Gemini OFF in tests
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        // A Groceries budget of $40 vs the month's $54.20 Groceries expense → over (the month is fully elapsed).
        await owner.PostAsJsonAsync("/api/family/finance/budgets", new { category = "Groceries", limitAmount = 40m });

        var res = await owner.GetAsync("/api/family/finance/ai/budget-check?month=2026-05");
        res.StatusCode.Should().Be(HttpStatusCode.OK); // ALWAYS 200, never 503
        var dto = await Json(res);

        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("month").GetString().Should().Be("2026-05");
        // The deterministic over/near/under list is the floor.
        var groceries = dto.GetProperty("budgets").EnumerateArray()
            .Single(b => b.GetProperty("category").GetString() == "Groceries");
        groceries.GetProperty("status").GetString().Should().Be("over"); // 54.20 projected over a 40 limit
        dto.GetProperty("overCount").GetInt32().Should().Be(1);
        // No narration when falling back (the floor drops it); no email anywhere.
        dto.GetProperty("narrative").ValueKind.Should().Be(JsonValueKind.Null);
        dto.GetProperty("tips").GetArrayLength().Should().Be(0);
        dto.GetRawText().Should().NotContain("@");

        // The read wrote nothing: still exactly one budget, one import batch.
        (await Json(await owner.GetAsync("/api/family/finance/budgets?month=2026-05")))
            .GetProperty("budgets").GetArrayLength().Should().Be(1);
        (await Json(await owner.GetAsync("/api/family/finance/imports"))).GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task Budget_routes_require_family_finance_on_top_of_family_use()
    {
        var (_, useOnly, _) = await ProvisionUser("family.use");
        await useOnly.GetAsync("/api/family/household");
        (await useOnly.GetAsync("/api/family/finance/budgets?month=2026-05"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/net-worth")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/savings")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await useOnly.GetAsync("/api/family/finance/ai/budget-check"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // =====================================================================================
    // MONEY OVERFLOW GUARD (MoneyCap) — an oversized amount is a clean 400, never a 500. The
    // numeric(18,2) money columns top out near 1e16; an input above MoneyCap (1e14) would otherwise
    // overflow the column into an unhandled Postgres 22003 (NumericValueOutOfRange) → 500. These pin
    // that the guard rejects the oversized value with a 400 while a normal in-range value still succeeds.
    // 1e15 (1,000,000,000,000,000) is comfortably > the 1e14 cap.
    // =====================================================================================

    private const decimal Oversized = 1e15m;

    [Fact]
    public async Task Balance_entry_rejects_an_oversized_amount_with_400_not_500_and_an_in_range_value_succeeds()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        var bankId = Account(await Json(await owner.GetAsync("/api/family/finance/accounts")), "SoFi Checking 1")
            .GetProperty("id").GetInt32();

        // An oversized balance → 400 BadRequest (the MoneyCap guard), NOT a 500 column overflow.
        (await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = Oversized }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // The oversized NEGATIVE (a huge liability) is bounded the same way (Math.Abs both directions).
        (await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = -Oversized }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // A normal in-range balance still succeeds (200) and lands in net worth.
        (await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance",
            new { asOfDate = "2026-05-01", balance = 5000.00m }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(await owner.GetAsync("/api/family/finance/net-worth")))
            .GetProperty("assets").GetDecimal().Should().Be(5000.00m);
    }

    [Fact]
    public async Task Savings_contribution_rejects_an_oversized_amount_with_400_not_500_and_an_in_range_value_succeeds()
    {
        var owner = await FinanceUser();
        var goalId = (await Json(await owner.PostAsJsonAsync("/api/family/finance/savings",
            new { name = "Emergency fund", targetAmount = 1000.00m, owner = "joint" }))).GetProperty("id").GetInt32();

        // An oversized contribution → 400 BadRequest (the MoneyCap guard on BOTH the input and the running total).
        (await owner.PostAsJsonAsync($"/api/family/finance/savings/{goalId}/contribute", new { amount = Oversized }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // A normal in-range contribution still succeeds (200) and moves saved.
        var contributed = await owner.PostAsJsonAsync(
            $"/api/family/finance/savings/{goalId}/contribute", new { amount = 250.00m });
        contributed.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(contributed)).GetProperty("savedAmount").GetDecimal().Should().Be(250.00m);
    }

    [Fact]
    public async Task Budget_limit_and_savings_target_reject_an_oversized_amount_with_400_not_500()
    {
        var owner = await FinanceUser();

        // POST /budgets with an oversized LimitAmount → 400 (TryNormalizeLimit's MoneyCap guard).
        (await owner.PostAsJsonAsync("/api/family/finance/budgets",
            new { category = "Groceries", limitAmount = Oversized }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // A normal in-range budget still succeeds (200).
        (await owner.PostAsJsonAsync("/api/family/finance/budgets",
            new { category = "Groceries", limitAmount = 100.00m }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // POST /savings with an oversized TargetAmount → 400 (same shared guard).
        (await owner.PostAsJsonAsync("/api/family/finance/savings",
            new { name = "Moon", targetAmount = Oversized }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // A normal in-range savings target still succeeds (200).
        (await owner.PostAsJsonAsync("/api/family/finance/savings",
            new { name = "Trip", targetAmount = 1000.00m }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // =====================================================================================
    // DISPLAY-TZ "TODAY" — a balance entry WITHOUT an asOfDate buckets to the DISPLAY-tz today,
    // not the raw-UTC day. Pins that the default date flows through TrackerVisibility.DisplayTzTodayAsync
    // (so an evening-boundary scenario records the display-tz day, not a UTC off-by-one).
    // =====================================================================================

    [Fact]
    public async Task Balance_entry_with_no_asOfDate_defaults_to_display_tz_today()
    {
        var owner = await FinanceUser();
        await owner.PostAsJsonAsync("/api/family/finance/import", new { fileName = "rm.csv", content = SampleCsv });
        var bankId = Account(await Json(await owner.GetAsync("/api/family/finance/accounts")), "SoFi Checking 1")
            .GetProperty("id").GetInt32();

        // POST a balance with NO asOfDate → the server defaults the snapshot day to display-tz "today".
        (await owner.PostAsJsonAsync($"/api/family/finance/accounts/{bankId}/balance", new { balance = 1234.00m }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // The net-worth per-account row reports that snapshot's asOfDate; it must equal display-tz today
        // (the SAME helper the endpoint uses), NOT raw DateTime.UtcNow.Date.
        var expected = (await DisplayTzToday()).ToString("yyyy-MM-dd");
        var bankRow = (await Json(await owner.GetAsync("/api/family/finance/net-worth")))
            .GetProperty("accounts").EnumerateArray()
            .Single(a => a.GetProperty("accountId").GetInt32() == bankId);
        bankRow.GetProperty("latestBalance").GetDecimal().Should().Be(1234.00m);
        bankRow.GetProperty("asOfDate").GetString().Should().Be(expected);
    }
}
