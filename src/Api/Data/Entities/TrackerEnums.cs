namespace Ccusage.Api.Data.Entities;

/// <summary>The fitness objective a user's tracker is oriented around; tags the exercise library too.</summary>
public enum TrackerGoal
{
    LoseWeight = 0,
    Maintain = 1,
    GainMuscle = 2,
    Endurance = 3,
}

/// <summary>Which meal a logged food belongs to, so the day view can group entries.</summary>
public enum MealType
{
    Breakfast = 0,
    Lunch = 1,
    Dinner = 2,
    Snack = 3,
}
