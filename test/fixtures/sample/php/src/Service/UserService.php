<?php
namespace App\Service;

use App\Repo\UserRepo;
use App\Exceptions\NotFound;

class UserService {
    public function __construct(private UserRepo $repo) {}

    public function get(int $id): array {
        $user = $this->repo->find($id);
        if ($user === null) {
            throw new NotFound("missing");
        }
        return $user;
    }
}
