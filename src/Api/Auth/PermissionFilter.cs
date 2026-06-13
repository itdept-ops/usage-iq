namespace Ccusage.Api.Auth;

/// <summary>
/// Endpoint filter that re-checks the database on every request: the user must exist,
/// be enabled, and hold the required permission. Pair with <c>.RequireAuthorization()</c>
/// (the JWT proves identity; this enforces authorization).
/// </summary>
public sealed class PermissionFilter(string permission) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var accessor = context.HttpContext.RequestServices.GetRequiredService<CurrentUserAccessor>();
        var user = await accessor.GetUserAsync(context.HttpContext.RequestAborted);

        if (user is null || !user.IsEnabled)
            return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                statusCode: StatusCodes.Status403Forbidden);

        if (!user.Permissions.Contains(permission))
            return Results.Json(new { message = $"You don't have permission: {permission}" },
                statusCode: StatusCodes.Status403Forbidden);

        return await next(context);
    }
}

public static class PermissionFilterExtensions
{
    /// <summary>Require a specific permission (re-checked against the DB each request).</summary>
    public static RouteHandlerBuilder RequirePermission(this RouteHandlerBuilder builder, string permission) =>
        builder.AddEndpointFilter(new PermissionFilter(permission));

    public static RouteGroupBuilder RequirePermission(this RouteGroupBuilder builder, string permission) =>
        builder.AddEndpointFilter(new PermissionFilter(permission));
}
