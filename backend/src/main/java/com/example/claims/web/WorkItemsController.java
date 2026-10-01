package com.example.claims.web;

import com.example.claims.store.ClaimQueries;
import com.example.claims.view.Views.Page;
import com.example.claims.view.Views.WorkItemView;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WorkItemsController {
    private final ClaimQueries queries;

    public WorkItemsController(ClaimQueries queries) {
        this.queries = queries;
    }

    /** GET /work-items?owner={id}&status=open — the mock's getQueue. */
    @GetMapping("/work-items")
    Page<WorkItemView> list(@RequestParam(required = false) UUID owner, @RequestParam(required = false) String status,
                            @RequestParam(defaultValue = "100") int limit) {
        return Page.of(queries.workItems(owner, status, Math.max(1, Math.min(limit, 500))));
    }
}
