using LinksQL;

namespace LinksQL.Tests;

/// <summary>
/// Tests for the store, the substitution engine and the query executor — the
/// heart of LinksQL. Mirrors <c>tests/engine.test.js</c> from the JavaScript
/// reference implementation 1:1; the CRUD examples mirror the canonical
/// operations from the specification.
/// </summary>
public class EngineTests
{
    private static Dictionary<string, long> Binding(params (string Key, long Value)[] pairs)
    {
        var binding = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var (key, value) in pairs)
        {
            binding[key] = value;
        }

        return binding;
    }

    // ----- LinksStore -------------------------------------------------------

    [Fact]
    public void Store_CreatesAndDeduplicatesBySourceTarget()
    {
        var store = new LinksStore();
        var a = store.Create(null, 1, 1);
        var b = store.Create(null, 1, 1);
        Assert.Equal(a.Index, b.Index);
        Assert.Equal(1, store.Size);
    }

    [Fact]
    public void Store_AllocatesFreshIdentitiesThatSkipUsedOnes()
    {
        var store = new LinksStore();
        store.Create(1, 1, 1);
        var next = store.Create(null, 2, 3);
        Assert.Equal(2, next.Index);
    }

    [Fact]
    public void Store_RejectsConflictingExplicitIdentities()
    {
        var store = new LinksStore();
        store.Create(5, 1, 2);
        Assert.Throws<LinkIntegrityError>(() => store.Create(6, 1, 2));
    }

    [Fact]
    public void Store_UpdatesStructureWhileKeepingIdentity()
    {
        var store = new LinksStore();
        var link = store.Create(null, 1, 1);
        var updated = store.Update(link.Index, 1, 2, null);
        Assert.Equal(link.Index, updated.Index);
        Assert.Equal(2, updated.Target);
        Assert.Null(store.FindByPair(1, 1));
    }

    [Fact]
    public void Store_ThrowsOnIntegrityViolations()
    {
        var store = new LinksStore();
        Assert.Throws<LinkIntegrityError>(() => store.Update(99, 1, 1, null));
    }

    // ----- Database CRUD via the single substitution operation --------------

    [Fact]
    public void Database_Create_MakesAPoint()
    {
        var db = new Database();
        var report = db.Query("() ((1 1))");
        Assert.Equal(Operation.Create, report.Operation);
        Assert.Equal(new[] { new Link(1, 1, 1) }, report.Created);
        Assert.Equal(1, db.Count());
    }

    [Fact]
    public void Database_Read_LoneRestrictionReturnsMatchesWithoutMutating()
    {
        var db = new Database();
        db.Query("() ((1 1))");
        var report = db.Query("((1: 1 1))");
        Assert.Equal(Operation.Read, report.Operation);
        Assert.Single(report.Matched);
        Assert.Equal(new Link(1, 1, 1), report.Matched[0].Links[0]);
        Assert.Empty(report.Created);
        Assert.Empty(report.Updated);
        Assert.Empty(report.Deleted);
    }

    [Fact]
    public void Database_Read_VariablesBindToEveryLink()
    {
        var db = new Database();
        db.Query("() ((1 1))");
        db.Query("() ((1 2))");
        var report = db.Query("(($i: $s $t))");
        Assert.Equal(Operation.Read, report.Operation);
        Assert.Equal(2, report.Matched.Count);
        var bindings = report.Matched.Select(row => row.Binding).ToArray();
        Assert.Equal(Binding(("i", 1), ("s", 1), ("t", 1)), bindings[0]);
        Assert.Equal(Binding(("i", 2), ("s", 1), ("t", 2)), bindings[1]);
    }

    [Fact]
    public void Database_Update_RewritesInPlace()
    {
        var db = new Database();
        db.Query("() ((1 1))");
        var report = db.Query("((1: 1 1)) ((1: 1 2))");
        Assert.Equal(Operation.Update, report.Operation);
        Assert.Equal(new[] { new Link(1, 1, 2) }, report.Updated);
        Assert.Equal(1, db.Count());
    }

    [Fact]
    public void Database_Delete_RemovesTheMatch()
    {
        var db = new Database();
        db.Query("() ((1 2))");
        var report = db.Query("((1 2)) ()");
        Assert.Equal(Operation.Delete, report.Operation);
        Assert.Equal(new[] { new Link(1, 1, 2) }, report.Deleted);
        Assert.Equal(0, db.Count());
    }

    [Fact]
    public void Database_NonMatchingRestrictionMakesNoChanges()
    {
        var db = new Database();
        db.Query("() ((1 1))");
        var report = db.Query("((9: 9 9)) ((9: 9 8))");
        Assert.Equal(Operation.Noop, report.Operation);
        Assert.Equal(1, db.Count());
    }

    // ----- conjunctive join across patterns ---------------------------------

    [Fact]
    public void Join_ComposesEdgesBySharingAVariable()
    {
        var db = new Database();

        // Edges 1->2 and 2->3 (identities allocated automatically).
        db.Query("() ((1 2))");
        db.Query("() ((2 3))");

        // Match a 2-hop path: ($x -> $y) and ($y -> $z).
        var report = db.Query("(($x $y) ($y $z))");
        Assert.Equal(Operation.Read, report.Operation);
        Assert.Single(report.Matched);
        Assert.Equal(Binding(("x", 1), ("y", 2), ("z", 3)), report.Matched[0].Binding);
    }

    // ----- named references -------------------------------------------------

    [Fact]
    public void Names_AutoCreatesNamesAsPointsAndLinksThem()
    {
        var db = new Database();
        var report = db.Query("() ((alice bob))");
        Assert.Equal(Operation.Create, report.Operation);

        // alice and bob become points; the relation links them.
        Assert.Equal(3, db.Count());
        var alice = db.Names.Resolve("alice");
        var bob = db.Names.Resolve("bob");
        Assert.NotNull(alice);
        Assert.NotNull(bob);
        Assert.NotNull(db.Store.FindByPair(alice.Value, bob.Value));
    }

    [Fact]
    public void Names_HonoursAutoCreateFalse()
    {
        var names = new Names(new LinksStore(), autoCreate: false);
        Assert.Throws<UnknownNameError>(() => names.Ensure("ghost"));
    }

    // ----- splitQuery -------------------------------------------------------

    [Fact]
    public void SplitQuery_TreatsOneNodeAsARead()
    {
        var split = Query.SplitQuery(Lino.Parse("((1: 1 1))"));
        Assert.Null(split.Substitution);
    }

    [Fact]
    public void SplitQuery_TreatsTwoNodesAsRestrictionPlusSubstitution()
    {
        var split = Query.SplitQuery(Lino.Parse("((1 1)) ((1 2))"));
        Assert.Single(split.Restriction);
        Assert.NotNull(split.Substitution);
        Assert.Single(split.Substitution);
    }

    [Fact]
    public void SplitQuery_RejectsMoreThanTwoTopLevelNodes()
    {
        Assert.Throws<QueryError>(() => Query.SplitQuery(Lino.Parse("(1) (2) (3)")));
    }

    // ----- serialisation and introspection ----------------------------------

    [Fact]
    public void Serialisation_SerialisesLinksToCanonicalLino()
    {
        Assert.Equal("(3: 1 2)", Query.LinkToLino(new Link(3, 1, 2)));
    }

    [Fact]
    public void Serialisation_RoundTripsTheWholeDatabaseThroughLino()
    {
        var db = new Database();
        db.Query("() ((1 1))");
        db.Query("() ((1 2))");
        var text = db.ToLino();
        var restored = new Database();
        restored.ImportLino(text);
        Assert.Equal(text, restored.ToLino());
    }

    [Fact]
    public void Introspection_IntrospectsLinkCountAndNames()
    {
        var db = new Database();
        db.Query("() ((alice bob))");
        var info = db.Introspect();
        Assert.Equal(3, info.LinkCount);
        Assert.Contains("alice", info.Names.Select(n => n.Name));
    }
}
