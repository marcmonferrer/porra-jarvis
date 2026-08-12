-- Add covering indexes for foreign-key joins and referential actions.

create index participants_pool_id_idx
  on public.participants (pool_id);

create index pools_created_by_idx
  on public.pools (created_by);

create index prize_awards_bet_id_idx
  on public.prize_awards (bet_id);

create index prize_results_finalized_by_idx
  on public.prize_results (finalized_by);

create index special_results_special_bet_id_idx
  on public.special_results (special_bet_id);
