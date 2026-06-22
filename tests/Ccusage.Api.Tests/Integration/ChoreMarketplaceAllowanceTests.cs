using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Chore Marketplace + Allowance (/api/family/chores/* + /api/family/allowance/*). Heavy on the
/// privacy/scoping invariants that make a kid login safe:
/// <list type="bullet">
///   <item>A CHILD GET /chores sees ONLY pool (open) + their own chores — never another child's, never any email.</item>
///   <item>claim → submit → approve awards credits EXACTLY once (no double-count between the completion
///   snapshot and the earn ledger row); the per-child balance == SUM(ledger).</item>
///   <item>A child cannot create/approve/reject chores, cannot read/modify another child's balance or chores,
///   and cannot record allowance moves (403).</item>
///   <item>allowance spend/payout/adjust require allowance.manage (a parent); overdraw is allowed.</item>
///   <item>the add-member Role accepts "child".</item>
/// </list>
/// Each test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ChoreMarketplaceAllowanceTests(WebAppFactory factory)
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
        var email = $"cma-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    /// <summary>A parent owner with a household + a child member added with Role="child".</summary>
    private async Task<(HttpClient parent, int parentId, HttpClient child, int childId)> ParentWithChild()
    {
        var (_, parent, parentId) = await ProvisionUser("family.use", "allowance.manage");
        await parent.GetAsync("/api/family/household"); // provision the household (parent = owner)
        var (_, child, childId) = await ProvisionUser("family.use", "chore.claim");
        var add = await parent.PostAsJsonAsync("/api/family/household/members",
            new { userId = childId, role = "child" });
        add.StatusCode.Should().Be(HttpStatusCode.OK);
        return (parent, parentId, child, childId);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static JsonElement Chores(JsonElement dto) => dto.GetProperty("chores");

    private static JsonElement ChoreById(JsonElement dto, long id) =>
        Chores(dto).EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == id);

    private async Task<long> CreatePoolChore(HttpClient parent, string title, decimal credit) =>
        FindChore(await Json(await parent.PostAsJsonAsync("/api/family/chores",
            new { title, source = "pool", creditValue = credit })), title);

    private async Task<long> CreateAssignedChore(HttpClient parent, string title, int childId, decimal credit) =>
        FindChore(await Json(await parent.PostAsJsonAsync("/api/family/chores",
            new { title, source = "assigned", assignedToUserId = childId, creditValue = credit })), title);

    private static long FindChore(JsonElement dto, string title) =>
        Chores(dto).EnumerateArray().Single(c => c.GetProperty("title").GetString() == title).GetProperty("id").GetInt64();

    // =====================================================================================
    // ADD-MEMBER ROLE
    // =====================================================================================

    [Fact]
    public async Task AddMember_accepts_child_role_and_sets_it_on_the_household()
    {
        var (parent, _, _, childId) = await ParentWithChild();
        var household = await Json(await parent.GetAsync("/api/family/household"));
        var childMember = household.GetProperty("members").EnumerateArray()
            .Single(m => m.GetProperty("userId").GetInt32() == childId);
        childMember.GetProperty("role").GetString().Should().Be("child");
        household.GetRawText().Should().NotContain("@"); // no email anywhere
    }

    [Fact]
    public async Task AddMember_child_without_chore_claim_is_rejected()
    {
        var (_, parent, _) = await ProvisionUser("family.use", "allowance.manage");
        await parent.GetAsync("/api/family/household");
        // A user with only family.use (no chore.claim) can't be added AS a child.
        var (_, _, plainId) = await ProvisionUser("family.use");
        (await parent.PostAsJsonAsync("/api/family/household/members", new { userId = plainId, role = "child" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // CHILD GET /chores SCOPING
    // =====================================================================================

    [Fact]
    public async Task Child_sees_only_pool_and_own_chores_never_another_childs_never_email()
    {
        var (parent, _, child, childId) = await ParentWithChild();
        // Add a SECOND child to the same household.
        var (_, child2, child2Id) = await ProvisionUser("family.use", "chore.claim");
        (await parent.PostAsJsonAsync("/api/family/household/members", new { userId = child2Id, role = "child" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var poolId = await CreatePoolChore(parent, "Take out trash", 1.50m);
        var mineId = await CreateAssignedChore(parent, "Clean room", childId, 2m);
        var siblingId = await CreateAssignedChore(parent, "Walk dog", child2Id, 2m);

        var dto = await Json(await child.GetAsync("/api/family/chores"));
        dto.GetProperty("role").GetString().Should().Be("child");
        dto.GetProperty("canManage").GetBoolean().Should().BeFalse();
        dto.GetProperty("tally").EnumerateArray().Should().BeEmpty(); // kids don't get the household tally

        var ids = Chores(dto).EnumerateArray().Select(c => c.GetProperty("id").GetInt64()).ToList();
        ids.Should().Contain(poolId);     // open pool chore is claimable
        ids.Should().Contain(mineId);     // their own assigned chore
        ids.Should().NotContain(siblingId); // NEVER the sibling's chore
        dto.GetRawText().Should().NotContain("@"); // no email anywhere on a child view
    }

    [Fact]
    public async Task Child_cannot_create_edit_delete_or_approve_chores()
    {
        var (parent, _, child, _) = await ParentWithChild();
        var poolId = await CreatePoolChore(parent, "Dishes", 1m);

        (await child.PostAsJsonAsync("/api/family/chores", new { title = "Sneaky", source = "pool" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await child.PatchAsJsonAsync($"/api/family/chores/{poolId}", new { title = "Hijack" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await child.DeleteAsync($"/api/family/chores/{poolId}"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        // approve/reject require allowance.manage which a child lacks → 403.
        (await child.PostAsJsonAsync($"/api/family/chores/{poolId}/approve", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await child.PostAsJsonAsync($"/api/family/chores/{poolId}/reject", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // =====================================================================================
    // CLAIM → SUBMIT → APPROVE (credits awarded exactly once; balance == SUM(ledger))
    // =====================================================================================

    [Fact]
    public async Task Claim_submit_approve_awards_credits_exactly_once_and_balance_equals_ledger_sum()
    {
        var (parent, _, child, childId) = await ParentWithChild();
        var poolId = await CreatePoolChore(parent, "Mow lawn", 5m);

        // Child claims → claimed by them.
        var claimed = await Json(await child.PostAsync($"/api/family/chores/{poolId}/claim", null));
        ChoreById(claimed, poolId).GetProperty("status").GetString().Should().Be("claimed");
        ChoreById(claimed, poolId).GetProperty("claimedByUserId").GetInt32().Should().Be(childId);

        // Child submits → submitted (no credits yet).
        var submitted = await Json(await child.PostAsync($"/api/family/chores/{poolId}/submit", null));
        ChoreById(submitted, poolId).GetProperty("status").GetString().Should().Be("submitted");
        // Balance still zero before approval.
        (await Json(await child.GetAsync("/api/family/allowance/me"))).GetProperty("balance").GetDecimal()
            .Should().Be(0m);

        // Parent approves → approved + credits awarded once.
        var approved = await Json(await parent.PostAsync($"/api/family/chores/{poolId}/approve", null));
        ChoreById(approved, poolId).GetProperty("status").GetString().Should().Be("approved");

        var me = await Json(await child.GetAsync("/api/family/allowance/me"));
        me.GetProperty("balance").GetDecimal().Should().Be(5m);
        var ledger = me.GetProperty("ledger").EnumerateArray().ToList();
        ledger.Count(e => e.GetProperty("kind").GetString() == "earn").Should().Be(1); // exactly one earn row
        ledger.Single(e => e.GetProperty("kind").GetString() == "earn").GetProperty("amount").GetDecimal()
            .Should().Be(5m);
        // Balance is exactly the sum of the ledger.
        me.GetProperty("balance").GetDecimal().Should().Be(ledger.Sum(e => e.GetProperty("amount").GetDecimal()));

        // Re-approving is idempotent — no second earn row, balance unchanged.
        await parent.PostAsync($"/api/family/chores/{poolId}/approve", null);
        var after = await Json(await child.GetAsync("/api/family/allowance/me"));
        after.GetProperty("balance").GetDecimal().Should().Be(5m);
        after.GetProperty("ledger").EnumerateArray()
            .Count(e => e.GetProperty("kind").GetString() == "earn").Should().Be(1);
    }

    [Fact]
    public async Task Child_cannot_claim_a_chore_already_claimed_409()
    {
        var (parent, _, child, _) = await ParentWithChild();
        var (_, child2, child2Id) = await ProvisionUser("family.use", "chore.claim");
        await parent.PostAsJsonAsync("/api/family/household/members", new { userId = child2Id, role = "child" });

        var poolId = await CreatePoolChore(parent, "Rake leaves", 2m);
        (await child.PostAsync($"/api/family/chores/{poolId}/claim", null)).StatusCode.Should().Be(HttpStatusCode.OK);
        // The second child can't claim it (already claimed).
        (await child2.PostAsync($"/api/family/chores/{poolId}/claim", null))
            .StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Child_cannot_submit_another_childs_chore()
    {
        var (parent, _, child, childId) = await ParentWithChild();
        var (_, child2, child2Id) = await ProvisionUser("family.use", "chore.claim");
        await parent.PostAsJsonAsync("/api/family/household/members", new { userId = child2Id, role = "child" });

        var mineId = await CreateAssignedChore(parent, "My chore", childId, 1m);
        // child2 cannot submit child1's assigned chore (it isn't theirs) → 403.
        (await child2.PostAsync($"/api/family/chores/{mineId}/submit", null))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Reject_sends_a_pool_chore_back_to_open_and_awards_nothing()
    {
        var (parent, _, child, childId) = await ParentWithChild();
        var poolId = await CreatePoolChore(parent, "Sweep", 3m);
        await child.PostAsync($"/api/family/chores/{poolId}/claim", null);
        await child.PostAsync($"/api/family/chores/{poolId}/submit", null);

        var rejected = await Json(await parent.PostAsJsonAsync($"/api/family/chores/{poolId}/reject",
            new { note = "do it again" }));
        var c = ChoreById(rejected, poolId);
        c.GetProperty("status").GetString().Should().Be("open");
        c.GetProperty("claimedByUserId").ValueKind.Should().Be(JsonValueKind.Null);

        // Nothing was awarded.
        (await Json(await child.GetAsync("/api/family/allowance/me"))).GetProperty("balance").GetDecimal()
            .Should().Be(0m);
    }

    // =====================================================================================
    // ALLOWANCE — parent moves (gated allowance.manage), child cross-access denied
    // =====================================================================================

    [Fact]
    public async Task Allowance_spend_payout_adjust_require_allowance_manage_403_for_a_child()
    {
        var (parent, _, child, childId) = await ParentWithChild();

        // A child cannot record any allowance move (no allowance.manage) → 403.
        (await child.PostAsJsonAsync($"/api/family/allowance/{childId}/spend", new { amount = 1m, category = "toys" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await child.PostAsJsonAsync($"/api/family/allowance/{childId}/payout", new { amount = 1m }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await child.PostAsJsonAsync($"/api/family/allowance/{childId}/adjust", new { amount = 1m }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        // And the parent manager view too.
        (await child.GetAsync("/api/family/allowance")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Parent_spend_payout_adjust_move_the_balance_and_show_in_the_manager()
    {
        var (parent, _, child, childId) = await ParentWithChild();
        // Earn 10 first.
        var poolId = await CreatePoolChore(parent, "Big job", 10m);
        await child.PostAsync($"/api/family/chores/{poolId}/claim", null);
        await child.PostAsync($"/api/family/chores/{poolId}/submit", null);
        await parent.PostAsync($"/api/family/chores/{poolId}/approve", null);

        await parent.PostAsJsonAsync($"/api/family/allowance/{childId}/spend",
            new { amount = 3m, category = "games", note = "a game" });   // -3
        await parent.PostAsJsonAsync($"/api/family/allowance/{childId}/payout", new { amount = 2m }); // -2
        await parent.PostAsJsonAsync($"/api/family/allowance/{childId}/adjust",
            new { amount = 1m, sign = 1 });                              // +1  → 10-3-2+1 = 6

        var manager = await Json(await parent.GetAsync("/api/family/allowance"));
        var card = manager.GetProperty("children").EnumerateArray()
            .Single(c => c.GetProperty("childUserId").GetInt32() == childId);
        card.GetProperty("balance").GetDecimal().Should().Be(6m);
        card.GetProperty("name").GetString().Should().NotBeNullOrWhiteSpace();
        manager.GetRawText().Should().NotContain("@"); // names only, never email

        // The child's own view agrees.
        (await Json(await child.GetAsync("/api/family/allowance/me"))).GetProperty("balance").GetDecimal()
            .Should().Be(6m);
    }

    [Fact]
    public async Task Parent_cannot_record_a_move_against_a_non_child_or_foreign_user_404()
    {
        var (parent, parentId, _, _) = await ParentWithChild();
        // The parent themself is not a child member → 404 (never act on a non-child).
        (await parent.PostAsJsonAsync($"/api/family/allowance/{parentId}/spend", new { amount = 1m }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        // A user in a different household → 404 (existence never leaked).
        var (_, _, outsiderId) = await ProvisionUser("family.use", "chore.claim");
        (await parent.PostAsJsonAsync($"/api/family/allowance/{outsiderId}/payout", new { amount = 1m }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_child_cannot_read_another_childs_chores_or_balance()
    {
        var (parent, _, child, childId) = await ParentWithChild();
        var (_, child2, child2Id) = await ProvisionUser("family.use", "chore.claim");
        await parent.PostAsJsonAsync("/api/family/household/members", new { userId = child2Id, role = "child" });

        // child2 earns 4.
        var poolId = await CreatePoolChore(parent, "Job for two", 4m);
        await child2.PostAsync($"/api/family/chores/{poolId}/claim", null);
        await child2.PostAsync($"/api/family/chores/{poolId}/submit", null);
        await parent.PostAsync($"/api/family/chores/{poolId}/approve", null);

        // child1's OWN view shows zero (never child2's balance) and no other child's ledger rows.
        var me = await Json(await child.GetAsync("/api/family/allowance/me"));
        me.GetProperty("childUserId").GetInt32().Should().Be(childId);
        me.GetProperty("balance").GetDecimal().Should().Be(0m);
        me.GetProperty("ledger").EnumerateArray().Should().BeEmpty();
    }

    // =====================================================================================
    // GATING / AUTH
    // =====================================================================================

    [Fact]
    public async Task Marketplace_and_allowance_require_family_use()
    {
        var (_, plain, plainId) = await ProvisionUser("dashboard.view");
        (await plain.GetAsync("/api/family/allowance/me")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/family/allowance")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsync("/api/family/chores/1/claim", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_parent_without_allowance_manage_cannot_approve_or_manage_allowance()
    {
        // family.use only (an adult member without allowance.manage).
        var (_, parent, _) = await ProvisionUser("family.use");
        await parent.GetAsync("/api/family/household");
        var (_, child, childId) = await ProvisionUser("family.use", "chore.claim");
        await parent.PostAsJsonAsync("/api/family/household/members", new { userId = childId, role = "child" });

        // They can still create chores (parent role), but approve + allowance moves need allowance.manage → 403.
        var poolId = await CreatePoolChore(parent, "Tidy", 1m);
        await child.PostAsync($"/api/family/chores/{poolId}/claim", null);
        await child.PostAsync($"/api/family/chores/{poolId}/submit", null);
        (await parent.PostAsync($"/api/family/chores/{poolId}/approve", null))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await parent.GetAsync("/api/family/allowance")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await parent.PostAsJsonAsync($"/api/family/allowance/{childId}/spend", new { amount = 1m }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
