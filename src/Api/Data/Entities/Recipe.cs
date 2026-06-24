namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One user's SAVED recipe ("My Recipes") — the persisted form of a what-to-eat / recipe-breakdown
/// PROPOSAL the user chose to keep. OWNER-SCOPED by the lower-cased <see cref="OwnerEmail"/>: a caller
/// only ever sees/edits their own recipes; a foreign or missing id is a 404 (existence never leaked).
///
/// Reuses the breakdown shape: a title, how many <see cref="Servings"/> it makes, structured
/// <see cref="Ingredients"/> ({Name, Quantity} child rows), PER-SERVING macros, optional ordered
/// <see cref="Steps"/> (newline-separated), and free-text <see cref="Notes"/>.
///
/// SHARING mirrors the tracker pattern: an owner-scoped <see cref="ShareWithContacts"/> boolean gates
/// read access for the owner's MUTUAL chat contacts (via <c>ContactGraph.IsContactAsync</c>). No email
/// is ever put on the wire — a shared recipe carries only the owner's user id + display name.
/// </summary>
public class Recipe
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the identity/ownership key.</summary>
    public string OwnerEmail { get; set; } = "";

    public string Title { get; set; } = "";

    /// <summary>How many servings the recipe makes (>=1). The macros below are PER-SERVING.</summary>
    public int Servings { get; set; } = 1;

    /// <summary>Per-serving calories (kcal).</summary>
    public int Calories { get; set; }

    /// <summary>Per-serving protein (g).</summary>
    public double ProteinG { get; set; }

    /// <summary>Per-serving carbohydrate (g).</summary>
    public double CarbG { get; set; }

    /// <summary>Per-serving fat (g).</summary>
    public double FatG { get; set; }

    /// <summary>Ordered preparation steps, newline-separated (optional).</summary>
    public string Steps { get; set; } = "";

    /// <summary>Free-text notes (optional).</summary>
    public string Notes { get; set; } = "";

    /// <summary>When true, the owner's mutual chat contacts may view (read-only) this recipe.</summary>
    public bool ShareWithContacts { get; set; }

    public DateTime CreatedUtc { get; set; }

    public DateTime UpdatedUtc { get; set; }

    /// <summary>The recipe's structured ingredient lines (owned; cascade-deleted with the recipe).</summary>
    public List<RecipeIngredient> Ingredients { get; set; } = new();
}

/// <summary>One structured ingredient line on a <see cref="Recipe"/>: a name and an optional free-text
/// quantity (e.g. "2 cups"). Ordered by <see cref="SortOrder"/> for stable display.</summary>
public class RecipeIngredient
{
    public long Id { get; set; }

    public long RecipeId { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Free-text amount (e.g. "200 g", "1 tbsp"); optional.</summary>
    public string Quantity { get; set; } = "";

    public int SortOrder { get; set; }

    public Recipe? Recipe { get; set; }
}
